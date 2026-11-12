import { test } from 'vitest';
import {
  DashError,
  events,
  validateManifest,
  type JobContext,
  type ModuleInstance,
  type ModuleServer,
} from '@dash/contract';
import { applyMigrations, createMockHost, createMockRouter, type MockHost } from './mock-host.js';

export interface ServerSuiteOptions {
  moduleDir: string;
  happyHttp?: (host: MockHost) => void;
  /** Non-GET routes that only change the caller's own view state, as "POST /read". */
  viewWrites?: string[];
}

export interface ContractCase {
  name: string;
  run: () => Promise<void>;
}

type JobFn = (ctx: JobContext) => Promise<void>;

const SENTINEL_PREFIX = 'S3CR3T-';

function fail(msg: string): never {
  throw new Error(msg);
}

function modulePrefix(id: string): string {
  return `m_${id.replace(/-/g, '_')}_`;
}

/** Table (and index/trigger/view) names a migration touches, from the DDL/DML statements it contains. */
export function migrationTargets(sql: string): string[] {
  const clean = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const id = String.raw`[\s]*["'\`\[]?([A-Za-z_][\w]*)`;
  const patterns = [
    String.raw`\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER|VIRTUAL\s+TABLE)(?:\s+IF\s+NOT\s+EXISTS)?` + id,
    String.raw`\bALTER\s+TABLE` + id,
    String.raw`\bDROP\s+(?:TABLE|INDEX|VIEW|TRIGGER)(?:\s+IF\s+EXISTS)?` + id,
    String.raw`\bINSERT\s+(?:OR\s+\w+\s+)?INTO` + id,
    String.raw`\bUPDATE(?:\s+OR\s+\w+)?` + id,
    String.raw`\bDELETE\s+FROM` + id,
    String.raw`\bON` + id, // CREATE INDEX ... ON <table>, triggers
  ];
  const out: string[] = [];
  for (const p of patterns) {
    for (const m of clean.matchAll(new RegExp(p, 'gi'))) {
      const name = m[1];
      if (name && !/^(CONFLICT|DELETE|UPDATE|CASCADE|SET|NULL|NO|RESTRICT)$/i.test(name)) out.push(name);
    }
  }
  return out;
}

async function settle(
  p: Promise<void>,
  ms: number,
): Promise<{ kind: 'ok' } | { kind: 'err'; error: unknown } | { kind: 'timeout' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout' }), ms);
  });
  try {
    return await Promise.race([
      p.then(
        () => ({ kind: 'ok' }) as const,
        (error: unknown) => ({ kind: 'err', error }) as const,
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

function freshHost(server: ModuleServer): MockHost {
  const { manifest } = server;
  const host = createMockHost(manifest);
  applyMigrations(host, server.migrations ?? []);
  const config = manifest.config.safeParse({});
  host.setConfig(config.success ? config.data : {});
  const settings = manifest.settings.safeParse({});
  const instance: ModuleInstance = {
    id: '00000000-0000-7000-8000-000000000001',
    ownerId: 'u1',
    pageId: 'p1',
    settings: settings.success ? settings.data : {},
  };
  host.setInstances([instance]);
  host.setUsers([{ id: 'u1', name: 'Test', handle: 'test' }]);
  return host;
}

/** One entry per (job, instance) pair; module-scoped jobs run once with a null instance. */
async function jobTargets(
  server: ModuleServer,
  host: MockHost,
): Promise<Array<{ name: string; fn: JobFn; instance: ModuleInstance | null }>> {
  const instances = await host.instances();
  const out: Array<{ name: string; fn: JobFn; instance: ModuleInstance | null }> = [];
  for (const spec of server.manifest.jobs) {
    const fn = server.jobs?.[spec.name] as JobFn | undefined;
    if (!fn) continue;
    if (spec.per === 'module') out.push({ name: spec.name, fn, instance: null });
    else for (const instance of instances) out.push({ name: spec.name, fn, instance });
  }
  return out;
}

function runJob(host: MockHost, t: { fn: JobFn; instance: ModuleInstance | null }, signal: AbortSignal): Promise<void> {
  return t.fn({ host, instance: t.instance, signal });
}

export function serverContractCases(server: ModuleServer, opts: ServerSuiteOptions): ContractCase[] {
  const { manifest } = server;
  const viewWrites = new Set(opts.viewWrites ?? []);
  const routeKey = (r: { method: string; path: string }): string => `${r.method} ${r.path}`;

  return [
    {
      name: 'manifest is valid',
      run: () => {
        const problems = validateManifest(manifest);
        if (problems.length > 0) fail(`manifest problems: ${problems.join('; ')}`);
        return Promise.resolve();
      },
    },
    {
      name: 'jobs match manifest',
      run: () => {
        const declared = manifest.jobs.map((j) => j.name);
        const handlers = Object.keys(server.jobs ?? {});
        const missing = declared.filter((n) => !handlers.includes(n));
        const extra = handlers.filter((n) => !declared.includes(n));
        if (missing.length > 0 || extra.length > 0) {
          fail(`jobs mismatch; missing handlers: [${missing.join(', ')}], undeclared handlers: [${extra.join(', ')}]`);
        }
        return Promise.resolve();
      },
    },
    {
      name: 'event handlers are declared',
      run: () => {
        const subscribes: readonly string[] = manifest.subscribes;
        const bad = Object.keys(server.on ?? {}).filter((k) => !subscribes.includes(k));
        if (bad.length > 0) fail(`handlers for events not in manifest.subscribes: ${bad.join(', ')}`);
        return Promise.resolve();
      },
    },
    {
      name: 'migrations only touch own tables',
      run: () => {
        const prefix = modulePrefix(manifest.id);
        const offenders: string[] = [];
        for (const m of server.migrations ?? []) {
          for (const target of migrationTargets(m.up)) {
            if (!target.startsWith(prefix)) offenders.push(`migration ${m.id}: "${target}"`);
          }
        }
        if (offenders.length > 0) fail(`targets outside ${prefix}*: ${offenders.join('; ')}`);
        return Promise.resolve();
      },
    },
    {
      name: 'every route declares a level',
      run: () => {
        const { routes } = createMockRouter(server, freshHost(server));
        const problems: string[] = [];
        for (const r of routes) {
          const level: unknown = r.level;
          if (level !== 'view' && level !== 'edit') problems.push(`${routeKey(r)} has no level`);
          else if (r.method !== 'GET' && level !== 'edit' && !viewWrites.has(routeKey(r))) {
            problems.push(`${routeKey(r)} mutates but is level "view" and not listed in viewWrites`);
          }
        }
        if (problems.length > 0) fail(problems.join('; '));
        return Promise.resolve();
      },
    },
    {
      name: 'view level cannot call edit routes',
      run: async () => {
        const router = createMockRouter(server, freshHost(server));
        const problems: string[] = [];
        for (const r of router.routes) {
          const mustBeDenied = r.level === 'edit' || (r.method !== 'GET' && !viewWrites.has(routeKey(r)));
          if (!mustBeDenied) continue;
          const res = await router.call(r.method, r.path, { level: 'view' });
          if (res.status !== 403) problems.push(`${routeKey(r)} returned ${res.status} for level view, expected 403`);
        }
        if (problems.length > 0) fail(problems.join('; '));
      },
    },
    {
      name: 'job survives bad upstream',
      run: async () => {
        const scenarios: Array<{ label: string; setup: (host: MockHost) => void; hang?: boolean }> = [
          { label: '(a) status 500', setup: (h) => h.respond(/.*/, { status: 500, data: { error: 'boom' } }) },
          { label: '(b) ECONNRESET', setup: (h) => h.respond(/.*/, new Error('ECONNRESET')) },
          { label: '(c) hang then abort', setup: (h) => h.respond(/.*/, 'hang'), hang: true },
          { label: '(d) html body', setup: (h) => h.respond(/.*/, { status: 200, data: '<html>not json</html>' }) },
        ];
        const problems: string[] = [];
        for (const sc of scenarios) {
          const host = freshHost(server);
          sc.setup(host);
          for (const target of await jobTargets(server, host)) {
            const label = `job "${target.name}" ${sc.label}`;
            const controller = new AbortController();
            const timer = sc.hang
              ? setTimeout(() => {
                  controller.abort();
                  host.abortPending();
                }, 10)
              : undefined;
            const result = await settle(runJob(host, target, controller.signal), 1000);
            if (timer) clearTimeout(timer);
            if (result.kind === 'timeout') problems.push(`${label} did not settle`);
            else if (result.kind === 'err') {
              const e = result.error;
              if (!(e instanceof DashError) || e.code !== 'upstream') {
                problems.push(`${label} threw ${describeError(e)} instead of DashError('upstream')`);
              }
            }
          }
          if (host.pushed.some((p) => p.data === undefined)) problems.push(`${sc.label}: pushed undefined`);
          if (host.published.length > 0) problems.push(`${sc.label}: published an event despite upstream failure`);
        }
        if (problems.length > 0) fail(problems.join('; '));
      },
    },
    {
      name: 'job publishes only declared events',
      run: async () => {
        const host = freshHost(server);
        opts.happyHttp?.(host);
        const problems: string[] = [];
        for (const target of await jobTargets(server, host)) {
          const result = await settle(runJob(host, target, new AbortController().signal), 5000);
          if (result.kind === 'timeout') problems.push(`job "${target.name}" did not settle`);
          else if (result.kind === 'err' && opts.happyHttp) {
            problems.push(`job "${target.name}" failed on happy path: ${describeError(result.error)}`);
          }
        }
        const declared: readonly string[] = manifest.publishes;
        for (const { name, payload } of host.published) {
          if (!declared.includes(name)) {
            problems.push(`published "${name}" which is not in manifest.publishes`);
            continue;
          }
          const parsed = events[name].safeParse(payload);
          if (!parsed.success) problems.push(`payload of "${name}" fails its schema: ${parsed.error.message}`);
        }
        if (problems.length > 0) fail(problems.join('; '));
      },
    },
    {
      name: 'snapshots contain no secrets',
      run: async () => {
        const host = freshHost(server);
        const issued: string[] = [];
        const store = new Map<string, string>();
        // Any secret the module asks for yields a fresh sentinel.
        host.secrets.get = (name) => {
          let v = store.get(name);
          if (v === undefined) {
            v = `${SENTINEL_PREFIX}${issued.length + 1}`;
            store.set(name, v);
            issued.push(v);
          }
          return Promise.resolve(v);
        };
        opts.happyHttp?.(host);
        for (const target of await jobTargets(server, host)) {
          await settle(runJob(host, target, new AbortController().signal), 5000);
        }
        const leaked = JSON.stringify([host.pushed, host.published, host.notified]) ?? '';
        if (leaked.includes(SENTINEL_PREFIX)) fail('a secret value appears in pushed data, published events or notifications');
        for (const s of issued) if (leaked.includes(s)) fail(`secret ${s} leaked`);
      },
    },
    {
      name: 'job honors abort signal',
      run: async () => {
        const problems: string[] = [];
        const host = freshHost(server);
        host.respond(/.*/, 'hang');
        for (const target of await jobTargets(server, host)) {
          const controller = new AbortController();
          const timer = setTimeout(() => {
            controller.abort();
            host.abortPending();
          }, 10);
          const result = await settle(runJob(host, target, controller.signal), 200);
          clearTimeout(timer);
          if (result.kind === 'timeout') problems.push(`job "${target.name}" still running 200 ms after abort`);
        }
        if (problems.length > 0) fail(problems.join('; '));
      },
    },
  ];
}

/** Registers the ten server contract cases with Vitest. Call from a module's server test file. */
export function runServerContractSuite(server: ModuleServer, opts: ServerSuiteOptions): void {
  for (const c of serverContractCases(server, opts)) test(c.name, c.run);
}
