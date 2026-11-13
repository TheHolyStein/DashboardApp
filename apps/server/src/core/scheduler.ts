// Job scheduler: one timer armed for the earliest due job (no per-job intervals, no polling), view
// gating, jittered intervals, exponential failure backoff, FIFO concurrency cap and a recovery spread
// so overdue jobs do not all fire in the same second after downtime.
import type BetterSqlite3 from 'better-sqlite3';
import { DashError, type InstanceId, type JobSpec, type ModuleId, type ModuleInstance } from '@dash/contract';
import type { LoadedModule, LoggerLike, Scheduler } from './modules/deps.js';

/** Modules whose always-jobs keep running in launcher minimal mode. */
export const CRITICAL_MODULES: readonly ModuleId[] = ['calendar', 'notifications', 'nas', 'network'];

const VIEW_WINDOW_MS = 90_000;
const MAX_BACKOFF_SEC = 3600;
const SPREAD_CAP_SEC = 60;
const ABORT_GRACE_MS = 5000;
const DEFAULT_TIMEOUT_SEC = 30;
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface SchedulerDeps {
  db: BetterSqlite3.Database;
  now: () => Date;
  random: () => number;
  maxConcurrent?: number;
  /** Placed instances of a module (provided by the pages/instances task). */
  instances: (moduleId: ModuleId) => ModuleInstance[];
  logger?: LoggerLike;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

interface Entry {
  mod: LoadedModule;
  spec: JobSpec;
  instance: ModuleInstance | null;
  nextAt: number | null;
  lastRunAt: number | null;
  lastOkAt: number | null;
  failures: number;
  running: boolean;
  queued: boolean;
  removed: boolean;
  controller?: AbortController;
  waiters: Array<() => void>;
}

interface StateRow {
  last_run_at: string | null;
  last_ok_at: string | null;
  failures: number;
  next_run_at: string | null;
}

const keyOf = (moduleId: string, job: string, instanceId: string): string => `${moduleId}\u0000${job}\u0000${instanceId}`;
const parseMs = (s: string | null): number | null => {
  if (s === null) return null;
  const n = Date.parse(s);
  return Number.isNaN(n) ? null : n;
};

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { db, now, random } = deps;
  const maxConcurrent = deps.maxConcurrent ?? 4;
  const setT = deps.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
  const log = deps.logger;
  const nowMs = (): number => now().getTime();
  const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

  const entries = new Map<string, Entry>();
  const mods = new Map<ModuleId, LoadedModule>();
  const knownInstances = new Map<ModuleId, ModuleInstance[]>();
  const viewed = new Map<InstanceId, number>();
  const queue: Entry[] = [];
  let running = 0;
  let started = false;
  let stopped = false;
  let minimal = false;
  let timer: unknown;
  let timerAt = Infinity;

  let selectState: BetterSqlite3.Statement | undefined;
  let upsertState: BetterSqlite3.Statement | undefined;

  const jitter = (): number => 0.9 + random() * 0.2;
  const spreadMs = (spec: JobSpec): number => random() * Math.min(spec.intervalSec, SPREAD_CAP_SEC) * 1000;
  const okDelay = (spec: JobSpec): number => spec.intervalSec * 1000 * jitter();
  const failDelay = (spec: JobSpec, failures: number): number =>
    Math.min(spec.intervalSec * 2 ** Math.min(failures, 20), MAX_BACKOFF_SEC) * 1000 * jitter();

  const critical = (e: Entry): boolean => CRITICAL_MODULES.includes(e.mod.id);
  const pausedByMinimal = (e: Entry): boolean => minimal && (e.spec.mode === 'whenViewed' || !critical(e));

  const isViewed = (e: Entry, t: number): boolean => {
    const fresh = (id: InstanceId): boolean => {
      const at = viewed.get(id);
      return at !== undefined && t - at <= VIEW_WINDOW_MS;
    };
    if (e.instance) return fresh(e.instance.id);
    // module-wide job: any placed instance of the module
    return (knownInstances.get(e.mod.id) ?? []).some((i) => fresh(i.id));
  };

  const eligible = (e: Entry, t: number): boolean =>
    !e.removed && e.mod.enabled && !e.mod.failed && !pausedByMinimal(e) && (e.spec.mode === 'always' || isViewed(e, t));

  function loadState(e: Entry): void {
    selectState ??= db.prepare(
      'SELECT last_run_at, last_ok_at, failures, next_run_at FROM job_state WHERE module_id = ? AND job = ? AND instance_id = ?',
    );
    const row = selectState.get(e.mod.id, e.spec.name, e.instance?.id ?? '') as StateRow | undefined;
    if (!row) return;
    e.lastRunAt = parseMs(row.last_run_at);
    e.lastOkAt = parseMs(row.last_ok_at);
    e.failures = row.failures;
    e.nextAt = parseMs(row.next_run_at);
  }

  /** Initial schedule: keep a future persisted next run; overdue or never-run jobs get the recovery spread. */
  function initSchedule(e: Entry): void {
    const t = nowMs();
    if (e.nextAt === null || e.nextAt <= t) e.nextAt = t + spreadMs(e.spec);
  }

  function addEntry(mod: LoadedModule, spec: JobSpec, instance: ModuleInstance | null): Entry {
    const e: Entry = {
      mod, spec, instance, nextAt: null, lastRunAt: null, lastOkAt: null, failures: 0,
      running: false, queued: false, removed: false, waiters: [],
    };
    loadState(e);
    if (started) initSchedule(e);
    entries.set(keyOf(mod.id, spec.name, instance?.id ?? ''), e);
    return e;
  }

  function flushWaiters(e: Entry): void {
    for (const fn of e.waiters.splice(0)) fn();
  }

  function removeEntry(e: Entry, purge: boolean): void {
    e.removed = true;
    entries.delete(keyOf(e.mod.id, e.spec.name, e.instance?.id ?? ''));
    const qi = queue.indexOf(e);
    if (qi >= 0) queue.splice(qi, 1);
    e.queued = false;
    if (purge) {
      db.prepare('DELETE FROM job_state WHERE module_id = ? AND job = ? AND instance_id = ?').run(
        e.mod.id, e.spec.name, e.instance?.id ?? '',
      );
    }
    if (!e.running) flushWaiters(e);
  }

  function persist(e: Entry): void {
    upsertState ??= db.prepare(
      `INSERT INTO job_state (module_id, job, instance_id, last_run_at, last_ok_at, failures, next_run_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (module_id, job, instance_id) DO UPDATE SET
         last_run_at = excluded.last_run_at, last_ok_at = excluded.last_ok_at,
         failures = excluded.failures, next_run_at = excluded.next_run_at`,
    );
    upsertState.run(e.mod.id, e.spec.name, e.instance?.id ?? '', iso(e.lastRunAt), iso(e.lastOkAt), e.failures, iso(e.nextAt));
  }

  function markSnapshot(e: Entry, ok: boolean): void {
    const flag = ok ? 1 : 0;
    if (e.instance) {
      db.prepare('UPDATE snapshots SET job_ok = ? WHERE module_id = ? AND instance_id = ?').run(flag, e.mod.id, e.instance.id);
    } else {
      db.prepare('UPDATE snapshots SET job_ok = ? WHERE module_id = ?').run(flag, e.mod.id);
    }
  }

  function enqueue(e: Entry, front: boolean): void {
    if (e.running) return;
    if (e.queued) {
      if (!front) return;
      queue.splice(queue.indexOf(e), 1);
    }
    e.queued = true;
    if (front) queue.unshift(e);
    else queue.push(e);
  }

  function run(e: Entry): void {
    running++;
    e.running = true;
    e.lastRunAt = nowMs();
    const controller = new AbortController();
    e.controller = controller;
    const handler = e.mod.server.jobs?.[e.spec.name];
    let settled = false;
    let hardTimer: unknown;
    const finish = (ok: boolean, err?: unknown): void => {
      if (settled) return;
      settled = true;
      clearT(softTimer);
      if (hardTimer !== undefined) clearT(hardTimer);
      running--;
      e.running = false;
      delete e.controller;
      if (!stopped && !e.removed) {
        const t = nowMs();
        if (ok) {
          e.failures = 0;
          e.lastOkAt = t;
          e.nextAt = t + okDelay(e.spec);
        } else {
          e.failures++;
          e.nextAt = t + failDelay(e.spec, e.failures);
          log?.warn(
            { module: e.mod.id, job: e.spec.name, failures: e.failures, err: err instanceof Error ? err.message : String(err) },
            'job failed',
          );
        }
        try {
          persist(e);
          markSnapshot(e, ok);
        } catch (dbErr) {
          log?.error({ module: e.mod.id, job: e.spec.name, err: String(dbErr) }, 'job state write failed');
        }
      }
      flushWaiters(e);
      if (!stopped) {
        pump();
        arm();
      }
    };
    const softTimer = setT(() => {
      controller.abort(new Error('job timeout'));
      hardTimer = setT(() => finish(false, new Error('job did not stop after timeout')), ABORT_GRACE_MS);
    }, (e.spec.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000);

    let p: Promise<void>;
    try {
      if (!handler) throw new Error(`no handler for job "${e.spec.name}"`);
      p = Promise.resolve(handler({ host: e.mod.host, instance: e.instance, signal: controller.signal }));
    } catch (err) {
      p = Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    p.then(
      () => finish(!controller.signal.aborted),
      (err: unknown) => finish(false, err),
    );
  }

  function pump(): void {
    while (!stopped && running < maxConcurrent) {
      const e = queue.shift();
      if (!e) return;
      e.queued = false;
      if (e.removed) continue;
      run(e);
    }
  }

  function tick(): void {
    timer = undefined;
    timerAt = Infinity;
    if (stopped) return;
    const t = nowMs();
    for (const e of entries.values()) {
      if (e.running || e.queued || e.nextAt === null || e.nextAt > t) continue;
      if (!e.mod.enabled || e.mod.failed) {
        e.nextAt = t + okDelay(e.spec); // look again next interval; picks up re-enabling
        continue;
      }
      if (eligible(e, t)) enqueue(e, false);
    }
    pump();
    arm();
  }

  /** Arms the single timer for the earliest job that can actually run when it falls due. */
  function arm(): void {
    if (!started || stopped) return;
    const t = nowMs();
    let earliest = Infinity;
    for (const e of entries.values()) {
      if (e.running || e.queued || e.nextAt === null || e.removed || pausedByMinimal(e)) continue;
      if (e.spec.mode === 'whenViewed' && (e.nextAt <= t || !isViewed(e, t))) continue; // waits for a view
      if (e.nextAt < earliest) earliest = e.nextAt;
    }
    if (earliest === timerAt && timer !== undefined) return;
    if (timer !== undefined) clearT(timer);
    timer = undefined;
    timerAt = Infinity;
    if (earliest === Infinity) return;
    timerAt = earliest;
    timer = setT(tick, Math.min(Math.max(0, earliest - t), MAX_TIMER_MS));
  }

  function register(mod: LoadedModule): void {
    mods.set(mod.id, mod);
    for (const e of [...entries.values()]) if (e.mod.id === mod.id) removeEntry(e, false);
    knownInstances.delete(mod.id);
    if (mod.failed) return;
    const jobs = mod.server.manifest.jobs;
    if (jobs.length === 0) return;
    const instances = deps.instances(mod.id);
    knownInstances.set(mod.id, instances);
    for (const spec of jobs) {
      if (spec.per === 'module') addEntry(mod, spec, null);
      else for (const inst of instances) addEntry(mod, spec, inst);
    }
    arm();
  }

  function syncInstances(moduleId: ModuleId): void {
    const mod = mods.get(moduleId);
    if (!mod || mod.failed) return;
    const instances = deps.instances(moduleId);
    knownInstances.set(moduleId, instances);
    const ids = new Set(instances.map((i) => i.id));
    for (const e of [...entries.values()]) {
      if (e.mod.id === moduleId && e.instance && !ids.has(e.instance.id)) removeEntry(e, true);
    }
    for (const spec of mod.server.manifest.jobs) {
      if (spec.per !== 'instance') continue;
      for (const inst of instances) {
        const existing = entries.get(keyOf(moduleId, spec.name, inst.id));
        if (existing) existing.instance = inst;
        else addEntry(mod, spec, inst);
      }
    }
    arm();
  }

  function markViewed(instanceIds: InstanceId[], at: Date): void {
    const atMs = at.getTime();
    const t = nowMs();
    for (const [id, v] of viewed) if (t - v > VIEW_WINDOW_MS) viewed.delete(id);
    for (const id of instanceIds) viewed.set(id, Math.max(atMs, viewed.get(id) ?? 0));
    if (!started || stopped) return;
    for (const e of entries.values()) {
      if (e.spec.mode !== 'whenViewed' || e.running || e.queued || !eligible(e, t)) continue;
      const overdue = e.nextAt !== null && e.nextAt <= t;
      const idle = e.failures === 0 && (e.lastRunAt === null || t - e.lastRunAt >= e.spec.intervalSec * 1000);
      if (overdue || idle) enqueue(e, false);
    }
    pump();
    arm();
  }

  function setMinimal(on: boolean): void {
    if (minimal === on) return;
    minimal = on;
    if (!on && started) {
      // resume: jobs that fell due while paused get the recovery spread instead of all starting at once
      const t = nowMs();
      for (const e of entries.values()) {
        if (!e.running && !e.queued && e.nextAt !== null && e.nextAt <= t) e.nextAt = t + spreadMs(e.spec);
      }
    }
    arm();
  }

  function runNow(moduleId: ModuleId, job: string, instanceId?: InstanceId): Promise<void> {
    const usable = [...entries.values()].filter(
      (e) =>
        e.mod.id === moduleId && e.spec.name === job && (instanceId === undefined || e.instance?.id === instanceId) &&
        e.mod.enabled && !e.mod.failed,
    );
    if (stopped || usable.length === 0) {
      return Promise.reject(new DashError('not_found', `unknown job ${moduleId}/${job}${instanceId ? `/${instanceId}` : ''}`));
    }
    const waits = usable.map(
      (e) =>
        new Promise<void>((resolve) => {
          e.waiters.push(resolve);
          enqueue(e, true);
        }),
    );
    pump();
    return Promise.all(waits).then(() => undefined);
  }

  function start(): void {
    if (started) return;
    started = true;
    stopped = false;
    for (const e of entries.values()) initSchedule(e);
    arm();
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (timer !== undefined) clearT(timer);
    timer = undefined;
    timerAt = Infinity;
    for (const e of queue.splice(0)) {
      e.queued = false;
      flushWaiters(e);
    }
    const active = [...entries.values()].filter((e) => e.running);
    if (active.length === 0) return;
    await new Promise<void>((resolve) => {
      let left = active.length;
      const grace = setT(resolve, ABORT_GRACE_MS);
      for (const e of active) {
        e.waiters.push(() => {
          if (--left === 0) {
            clearT(grace);
            resolve();
          }
        });
        e.controller?.abort(new Error('scheduler stopping'));
      }
    });
  }

  function status(): ReturnType<Scheduler['status']> {
    return [...entries.values()].map((e) => ({
      moduleId: e.mod.id,
      job: e.spec.name,
      instanceId: e.instance?.id ?? null,
      lastRunAt: iso(e.lastRunAt),
      lastOkAt: iso(e.lastOkAt),
      failures: e.failures,
      nextRunAt: iso(e.nextAt),
    }));
  }

  return { register, syncInstances, markViewed, setMinimal, runNow, status, start, stop };
}
