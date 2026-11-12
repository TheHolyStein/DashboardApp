import Database from 'better-sqlite3';
import {
  DashError,
  HTTP_STATUS,
  type EventName,
  type HostServices,
  type HttpOptions,
  type HttpResult,
  type InstanceId,
  type Migration,
  type ModuleDb,
  type ModuleInstance,
  type ModuleManifest,
  type ModuleRouter,
  type ModuleServer,
  type Notification,
  type RouteOptions,
  type RouteRequest,
} from '@dash/contract';

export interface MockResponse {
  status?: number;
  data?: unknown;
  headers?: Record<string, string>;
}

export interface MockHost extends HostServices {
  pushed: Array<{ instanceId: InstanceId | null; data: unknown }>;
  published: Array<{ name: EventName; payload: unknown }>;
  notified: Notification[];
  requests: Array<{ url: string; opts?: HttpOptions }>;
  respond(match: string | RegExp, response: MockResponse | Error | 'hang'): void;
  /** Rejects every hanging fetch with DashError('upstream', 'aborted'). Call it when aborting a job's signal. */
  abortPending(): void;
  setNow(d: Date): void;
  advance(ms: number): void;
  setConfig(c: unknown): void;
  setInstances(list: ModuleInstance[]): void;
  setUsers(u: Array<{ id: string; name: string; handle: string }>): void;
}

interface Rule {
  match: string | RegExp;
  response: MockResponse | Error | 'hang';
}

function ruleMatches(match: string | RegExp, url: string): boolean {
  return typeof match === 'string' ? url.includes(match) : match.test(url);
}

function shapeData(data: unknown, as: NonNullable<HttpOptions['as']>): unknown {
  if (as === 'json') {
    if (typeof data !== 'string') return data;
    try {
      return JSON.parse(data) as unknown;
    } catch {
      throw new DashError('upstream', 'response body is not valid JSON');
    }
  }
  if (as === 'text') return typeof data === 'string' ? data : JSON.stringify(data);
  if (data instanceof Uint8Array) return data;
  return new TextEncoder().encode(typeof data === 'string' ? data : JSON.stringify(data));
}

function wrapDb(db: Database.Database): ModuleDb {
  return {
    run: (sql, params = []) => ({ changes: db.prepare(sql).run(...params).changes }),
    all: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).all(...params) as T[],
    get: <T>(sql: string, params: unknown[] = []) => db.prepare(sql).get(...params) as T | undefined,
    transaction: <T>(fn: () => T) => db.transaction(fn)(),
  };
}

export function createMockHost(manifest: ModuleManifest, opts: { now?: Date } = {}): MockHost {
  let nowMs = (opts.now ?? new Date('2026-01-01T12:00:00.000Z')).getTime();
  let config: unknown = {};
  let instances: ModuleInstance[] = [];
  let users: Array<{ id: string; name: string; handle: string }> = [];
  const rules: Rule[] = [];
  const hanging = new Set<(e: DashError) => void>();
  const kv = new Map<string, unknown>();
  const blobs = new Map<string, { data: Uint8Array; contentType: string }>();
  const secrets = new Map<string, string>();
  const sqlite = new Database(':memory:');

  const host: MockHost = {
    moduleId: manifest.id,
    pushed: [],
    published: [],
    notified: [],
    requests: [],
    http: {
      fetch<T = unknown>(url: string, o?: HttpOptions): Promise<HttpResult<T>> {
        host.requests.push(o === undefined ? { url } : { url, opts: o });
        const rule = rules.find((r) => ruleMatches(r.match, url));
        if (!rule) return Promise.reject(new DashError('upstream', `no mock response for ${url}`));
        const { response } = rule;
        if (response instanceof Error) return Promise.reject(response);
        if (response === 'hang') {
          return new Promise<HttpResult<T>>((_, reject) => {
            const abort = (e: DashError): void => {
              hanging.delete(abort);
              reject(e);
            };
            hanging.add(abort);
          });
        }
        try {
          const data = shapeData(response.data, o?.as ?? 'json') as T;
          return Promise.resolve({
            status: response.status ?? 200,
            headers: response.headers ?? {},
            data,
            fromCache: false,
          });
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
    },
    store: {
      get: <T>(key: string) => Promise.resolve(kv.get(key) as T | undefined),
      set: (key, value) => {
        kv.set(key, value);
        return Promise.resolve();
      },
      delete: (key) => {
        kv.delete(key);
        return Promise.resolve();
      },
      keys: (prefix = '') => Promise.resolve([...kv.keys()].filter((k) => k.startsWith(prefix))),
      db: wrapDb(sqlite),
      blob: {
        put: (key, data, contentType) => {
          blobs.set(key, { data, contentType });
          return Promise.resolve();
        },
        get: (key) => Promise.resolve(blobs.get(key)),
        delete: (key) => {
          blobs.delete(key);
          return Promise.resolve();
        },
      },
    },
    secrets: {
      get: (name) => Promise.resolve(secrets.get(name)),
      set: (name, value) => {
        secrets.set(name, value);
        return Promise.resolve();
      },
      delete: (name) => {
        secrets.delete(name);
        return Promise.resolve();
      },
    },
    bus: {
      publish: (name, payload) => {
        host.published.push({ name, payload });
      },
    },
    push: (instanceId, data) => {
      host.pushed.push({ instanceId, data });
    },
    notify: (n) => {
      host.notified.push(n);
    },
    config: <C>() => Promise.resolve(config as C),
    instances: <S>() => Promise.resolve(instances as Array<ModuleInstance<S>>),
    users: () => Promise.resolve(users),
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    now: () => new Date(nowMs),
    respond: (match, response) => {
      rules.push({ match, response });
    },
    abortPending: () => {
      for (const abort of [...hanging]) abort(new DashError('upstream', 'aborted'));
    },
    setNow: (d) => {
      nowMs = d.getTime();
    },
    advance: (ms) => {
      nowMs += ms;
    },
    setConfig: (c) => {
      config = c;
    },
    setInstances: (list) => {
      instances = list;
    },
    setUsers: (u) => {
      users = u;
    },
  };
  return host;
}

/** Runs the module's migrations (in id order) against the mock host's in-memory database. */
export function applyMigrations(host: MockHost, migrations: Migration[]): void {
  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    host.store.db.run(m.up);
  }
}

type Level = 'view' | 'edit';
type Handler = (req: RouteRequest) => Promise<unknown>;
interface RegisteredRoute {
  method: string;
  path: string;
  level: Level;
  opts: RouteOptions;
  handler: Handler;
}

export interface MockRouter {
  call(
    method: string,
    path: string,
    req: { level: Level; body?: unknown; query?: unknown; user?: Partial<RouteRequest['user']> },
  ): Promise<{ status: number; body: unknown }>;
  routes: Array<{ method: string; path: string; level: Level }>;
}

function errorBody(code: string, message: string, details?: unknown): { error: { code: string; message: string; details?: unknown } } {
  return { error: details === undefined ? { code, message } : { code, message, details } };
}

function matchPath(template: string, actual: string): Record<string, string> | null {
  const t = template.split('/').filter(Boolean);
  const a = actual.split('?')[0]!.split('/').filter(Boolean);
  if (t.length !== a.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < t.length; i++) {
    const seg = t[i]!;
    const val = a[i]!;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(val);
    else if (seg !== val) return null;
  }
  return params;
}

export function createMockRouter(server: ModuleServer, host: MockHost): MockRouter {
  const registered: RegisteredRoute[] = [];
  const add =
    (method: string) =>
    (path: string, opts: RouteOptions, handler: Handler): void => {
      registered.push({ method, path, level: opts.level, opts, handler });
    };
  const router: ModuleRouter = {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
    raw: () => undefined,
  };
  server.routes?.(router, host);

  return {
    routes: registered.map(({ method, path, level }) => ({ method, path, level })),
    async call(method, path, req) {
      const verb = method.toUpperCase();
      let route: RegisteredRoute | undefined;
      let params: Record<string, string> = {};
      for (const r of registered) {
        if (r.method !== verb) continue;
        const m = matchPath(r.path, path);
        if (m) {
          route = r;
          params = m;
          break;
        }
      }
      if (!route) return { status: 404, body: errorBody('not_found', `no route ${verb} ${path}`) };
      if (route.level === 'edit' && req.level === 'view') {
        return { status: 403, body: errorBody('forbidden', 'edit level required') };
      }
      let body = req.body;
      let query = req.query;
      if (route.opts.body) {
        const parsed = route.opts.body.safeParse(body);
        if (!parsed.success) return { status: 422, body: errorBody('invalid', 'invalid body', parsed.error.issues) };
        body = parsed.data;
      }
      if (route.opts.query) {
        const parsed = route.opts.query.safeParse(query ?? {});
        if (!parsed.success) return { status: 422, body: errorBody('invalid', 'invalid query', parsed.error.issues) };
        query = parsed.data;
      }
      const request: RouteRequest = {
        user: { id: 'u1', name: 'Test', role: 'member', ...req.user },
        level: req.level,
        params,
        query,
        body,
        headers: {},
        raw: null,
      };
      try {
        return { status: 200, body: await route.handler(request) };
      } catch (e) {
        if (e instanceof DashError) return { status: HTTP_STATUS[e.code], body: errorBody(e.code, e.message, e.details) };
        return { status: 500, body: errorBody('internal', e instanceof Error ? e.message : 'internal error') };
      }
    },
  };
}
