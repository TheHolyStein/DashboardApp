/* eslint-disable @typescript-eslint/require-await */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleInstance } from '@dash/contract';
import { openDb } from '../../src/core/db.ts';
import { migrateCore } from '../../src/core/migrate.ts';
import { createScheduler, CRITICAL_MODULES } from '../../src/core/scheduler.ts';
import { jobModule, silentLogger } from './module-env.ts';

const START = Date.parse('2026-11-12T10:00:00.000Z');
const inst = (id: string): ModuleInstance => ({ id, ownerId: 'u', pageId: 'p', settings: {} });

function setup(opts: { random?: () => number; instances?: Record<string, ModuleInstance[]>; maxConcurrent?: number } = {}) {
  const db = openDb(':memory:');
  migrateCore(db);
  const instances = opts.instances ?? {};
  const sched = createScheduler({
    db,
    now: () => new Date(Date.now()),
    random: opts.random ?? (() => 0.5),
    ...(opts.maxConcurrent ? { maxConcurrent: opts.maxConcurrent } : {}),
    instances: (m) => instances[m] ?? [],
    logger: silentLogger,
  });
  return { db, sched, instances };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => {
  vi.useRealTimers();
});

const sec = async (n: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(n * 1000);
};

describe('scheduler', () => {
  it('always job runs on interval with jitter within ±10%', async () => {
    for (const r of [0, 0.999]) {
      const times: number[] = [];
      const { sched } = setup({ random: () => r });
      sched.register(jobModule('m', [{ name: 'j', intervalSec: 100, run: async () => void times.push(Date.now() - START) }]));
      sched.start();
      await sec(500);
      await sched.stop();
      expect(times.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < times.length; i++) {
        const gap = (times[i]! - times[i - 1]!) / 1000;
        expect(gap).toBeGreaterThanOrEqual(90 - 0.01);
        expect(gap).toBeLessThanOrEqual(110 + 0.01);
      }
    }
  });

  it('whenViewed job does not run when not viewed', async () => {
    const run = vi.fn(async () => {});
    const { sched } = setup();
    sched.register(jobModule('m', [{ name: 'j', intervalSec: 10, mode: 'whenViewed', per: 'instance', run }]));
    sched.start();
    await sec(300);
    expect(run).not.toHaveBeenCalled();
  });

  it('whenViewed job runs immediately on first view when overdue', async () => {
    const seenIds: Array<string | undefined> = [];
    const run = vi.fn(async (ctx: { instance: { id: string } | null }) => void seenIds.push(ctx.instance?.id));
    const { sched } = setup({ instances: { m: [inst('i1')] } });
    sched.register(jobModule('m', [{ name: 'j', intervalSec: 600, mode: 'whenViewed', per: 'instance', run }]));
    sched.start();
    await sec(5);
    sched.markViewed(['i1'], new Date(Date.now()));
    await sec(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(seenIds).toEqual(["i1"]);
    // not overdue anymore: another view right away does not run it again
    sched.markViewed(['i1'], new Date(Date.now()));
    await sec(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('viewed mark expires after 90 s', async () => {
    const run = vi.fn(async () => {});
    const { sched } = setup({ instances: { m: [inst('i1')] } });
    sched.register(jobModule('m', [{ name: 'j', intervalSec: 30, mode: 'whenViewed', per: 'instance', run }]));
    sched.start();
    sched.markViewed(['i1'], new Date(Date.now()));
    await sec(89);
    const during = run.mock.calls.length;
    expect(during).toBeGreaterThanOrEqual(2);
    await sec(40); // mark is now older than 90 s
    const after = run.mock.calls.length;
    await sec(300);
    expect(run.mock.calls.length).toBe(after);
    await sched.stop();
  });

  it('failure backs off 2×,4×, … capped at 3600 s; success resets', async () => {
    let fail = true;
    const { sched } = setup(); // random 0.5 -> jitter exactly 1
    sched.register(
      jobModule('m', [
        {
          name: 'j',
          intervalSec: 600,
          run: async () => {
            if (fail) throw new Error('x');
          },
        },
      ]),
    );
    sched.start();
    const next = (): number => Date.parse(sched.status()[0]!.nextRunAt!) - Date.parse(sched.status()[0]!.lastRunAt!);
    await sec(31); // spread 0.5*60 = 30 s -> first run done
    expect(sched.status()[0]!.failures).toBe(1);
    expect(next()).toBe(1200 * 1000);
    await sec(1200);
    expect(sched.status()[0]!.failures).toBe(2);
    expect(next()).toBe(2400 * 1000);
    await sec(2400);
    expect(sched.status()[0]!.failures).toBe(3);
    expect(next()).toBe(3600 * 1000); // 4800 capped
    fail = false;
    await sec(3600);
    const st = sched.status()[0]!;
    expect(st.failures).toBe(0);
    expect(st.lastOkAt).not.toBeNull();
    expect(next()).toBe(600 * 1000);
    await sched.stop();
  });

  it('timeout aborts the job signal', async () => {
    let signal: AbortSignal | undefined;
    const { sched } = setup();
    sched.register(
      jobModule('m', [
        {
          name: 'j',
          intervalSec: 60,
          timeoutSec: 10,
          run: async (ctx) => {
            signal = ctx.signal;
            await new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('aborted'))));
          },
        },
      ]),
    );
    sched.start();
    await sec(31); // started at 30 s
    expect(signal?.aborted).toBe(false);
    await sec(10);
    expect(signal?.aborted).toBe(true);
    expect(sched.status()[0]!.failures).toBe(1);
    await sched.stop();
  });

  it('timeout releases the slot 5 s after abort even if the job never settles', async () => {
    const hang = vi.fn(() => new Promise<void>(() => {}));
    const quick = vi.fn(async () => {});
    const { sched } = setup({ maxConcurrent: 1, random: () => 0 });
    sched.register(jobModule('a', [{ name: 'hang', intervalSec: 3600, timeoutSec: 10, run: hang }]));
    sched.register(jobModule('b', [{ name: 'quick', intervalSec: 3600, run: quick }]));
    sched.start();
    await sec(1);
    expect(hang).toHaveBeenCalledTimes(1);
    expect(quick).not.toHaveBeenCalled();
    await sec(13); // t = 14 s, grace ends at 15 s
    expect(quick).not.toHaveBeenCalled();
    await sec(2);
    expect(quick).toHaveBeenCalledTimes(1);
    expect(sched.status().find((s) => s.moduleId === 'a')!.failures).toBe(1);
    await sched.stop();
  });

  it('no more than 4 jobs run concurrently', async () => {
    let active = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const run = async (): Promise<void> => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => release.push(r));
      active--;
    };
    const { sched } = setup({ random: () => 0 });
    sched.register(jobModule('m', Array.from({ length: 10 }, (_, i) => ({ name: `j${i}`, intervalSec: 3600, run }))));
    sched.start();
    await sec(1);
    expect(active).toBe(4);
    let rounds = 0;
    while (release.length && rounds++ < 50) {
      release.shift()!();
      await sec(0);
    }
    expect(peak).toBe(4);
    await sched.stop();
  });

  it('minimal mode pauses non-critical jobs and resumes them', async () => {
    expect(CRITICAL_MODULES).toEqual(['calendar', 'notifications', 'nas', 'network']);
    const normal = vi.fn(async () => {});
    const crit = vi.fn(async () => {});
    const { sched } = setup();
    sched.register(jobModule('weather', [{ name: 'j', intervalSec: 10, run: normal }]));
    sched.register(jobModule('calendar', [{ name: 'j', intervalSec: 10, run: crit }]));
    sched.start();
    await sec(30);
    sched.setMinimal(true);
    const n0 = normal.mock.calls.length;
    const c0 = crit.mock.calls.length;
    await sec(100);
    expect(normal.mock.calls.length).toBe(n0);
    expect(crit.mock.calls.length).toBeGreaterThan(c0);
    sched.setMinimal(false);
    await sec(30);
    expect(normal.mock.calls.length).toBeGreaterThan(n0);
    await sched.stop();
  });

  it('per-instance job runs once per placed instance; module job once', async () => {
    const seen: Array<string | null> = [];
    const { sched } = setup({ instances: { m: [inst('a'), inst('b'), inst('c')] } });
    sched.register(
      jobModule('m', [
        { name: 'pi', intervalSec: 3600, per: 'instance', run: async (c) => void seen.push(c.instance?.id ?? null) },
        { name: 'pm', intervalSec: 3600, per: 'module', run: async (c) => void seen.push(c.instance === null ? 'module' : 'bad') },
      ]),
    );
    sched.start();
    await sec(61);
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'module']);
    expect(sched.status()).toHaveLength(4);
    await sched.stop();
  });

  it('syncInstances adds and removes per-instance schedules and deletes state', async () => {
    const { sched, db, instances } = setup({ instances: { m: [inst('a'), inst('b')] } });
    sched.register(jobModule('m', [{ name: 'pi', intervalSec: 3600, per: 'instance' }]));
    sched.start();
    await sec(61);
    expect(db.prepare('SELECT instance_id FROM job_state ORDER BY 1').pluck().all()).toEqual(['a', 'b']);
    instances.m = [inst('b'), inst('c')];
    sched.syncInstances('m');
    expect(sched.status().map((s) => s.instanceId).sort()).toEqual(['b', 'c']);
    expect(db.prepare('SELECT instance_id FROM job_state ORDER BY 1').pluck().all()).toEqual(['b']);
    await sched.stop();
  });

  it('writes job_state and marks snapshots job_ok', async () => {
    let fail = false;
    const { sched, db } = setup({ instances: { m: [inst('a'), inst('b')] } });
    const ins = db.prepare("INSERT INTO snapshots (module_id, instance_id, data, updated_at) VALUES ('m', ?, '{}', 'x')");
    ins.run('a');
    ins.run('b');
    sched.register(
      jobModule('m', [
        {
          name: 'pi',
          intervalSec: 3600,
          per: 'instance',
          run: async (c) => {
            if (fail && c.instance?.id === 'a') throw new Error('x');
          },
        },
      ]),
    );
    sched.start();
    await sec(61);
    fail = true;
    await sched.runNow('m', 'pi', 'a');
    const rows = db.prepare('SELECT instance_id, job_ok FROM snapshots ORDER BY 1').all();
    expect(rows).toEqual([
      { instance_id: 'a', job_ok: 0 },
      { instance_id: 'b', job_ok: 1 },
    ]);
    await sched.stop();
  });

  it('runNow runs the job even when view-gated; unknown job rejects with not_found', async () => {
    const run = vi.fn(async () => {});
    const { sched } = setup();
    sched.register(jobModule('m', [{ name: 'j', intervalSec: 3600, mode: 'whenViewed', run }]));
    sched.start();
    await sched.runNow('m', 'j');
    expect(run).toHaveBeenCalledTimes(1);
    await expect(sched.runNow('m', 'nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(sched.runNow('zzz', 'j')).rejects.toMatchObject({ code: 'not_found' });
    await sched.stop();
  });

  it('disabled and failed modules are not scheduled', async () => {
    const run = vi.fn(async () => {});
    const { sched } = setup();
    sched.register(jobModule('off', [{ name: 'j', intervalSec: 10, run }], { enabled: false }));
    sched.register(jobModule('bad', [{ name: 'j', intervalSec: 10, run }], { failed: 'x' }));
    sched.start();
    await sec(200);
    expect(run).not.toHaveBeenCalled();
    await expect(sched.runNow('off', 'j')).rejects.toMatchObject({ code: 'not_found' });
    expect(sched.status().filter((s) => s.moduleId === 'bad')).toEqual([]);
    await sched.stop();
  });

  it('state survives restart: failures and backoff restored', async () => {
    const { sched, db } = setup();
    sched.register(
      jobModule('m', [
        {
          name: 'j',
          intervalSec: 600,
          run: async () => {
            throw new Error('x');
          },
        },
      ]),
    );
    sched.start();
    await sec(31);
    const before = sched.status()[0]!;
    expect(before.failures).toBe(1);
    await sched.stop();

    const run = vi.fn(async () => {});
    const sched2 = createScheduler({ db, now: () => new Date(Date.now()), random: () => 0.5, instances: () => [], logger: silentLogger });
    sched2.register(jobModule('m', [{ name: 'j', intervalSec: 600, run }]));
    sched2.start();
    const after = sched2.status()[0]!;
    expect(after.failures).toBe(1);
    expect(after.nextRunAt).toBe(before.nextRunAt);
    expect(after.lastRunAt).toBe(before.lastRunAt);
    await sec(1100);
    expect(run).not.toHaveBeenCalled(); // 1200 s backoff still pending
    await sec(200);
    expect(run).toHaveBeenCalledTimes(1);
    await sched2.stop();
  });

  it('stop aborts running jobs and resolves once they settle', async () => {
    let signal: AbortSignal | undefined;
    const { sched } = setup({ random: () => 0 });
    sched.register(
      jobModule('m', [
        {
          name: 'j',
          intervalSec: 60,
          run: async (c) => {
            signal = c.signal;
            await new Promise((_, rej) => c.signal.addEventListener('abort', () => rej(new Error('a'))));
          },
        },
      ]),
    );
    sched.start();
    await sec(1);
    await sched.stop();
    expect(signal?.aborted).toBe(true);
  });
});
