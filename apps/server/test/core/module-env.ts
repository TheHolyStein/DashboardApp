// Test harness for module tests: in-test fakes for the A4-A8 dependencies, a tiny module builder,
// and a full app (db + loader + host factory + router) around them.
/* eslint-disable @typescript-eslint/require-await */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { EventName, HostServices, ModuleManifest, ModuleServer } from '@dash/contract';
import { defineManifest, defineServer } from '@dash/module-kit';
import type BetterSqlite3 from 'better-sqlite3';
import { buildApp } from '../../src/core/app.ts';
import { loadConfig } from '../../src/core/config.ts';
import { openDb } from '../../src/core/db.ts';
import { migrateCore } from '../../src/core/migrate.ts';
import type { HostDeps } from '../../src/core/modules/host.ts';
import { createHost } from '../../src/core/modules/host.ts';
import type { LoggerLike } from '../../src/core/modules/deps.ts';
import { loadModules, type LoadedModule } from '../../src/core/modules/loader.ts';
import type { AuthSeam } from '../../src/seams.ts';
import { testAuth } from './helpers.ts';

export const silentLogger: LoggerLike = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

export function manifestFor(id: string, extra: Partial<ModuleManifest> = {}): ModuleManifest {
  return defineManifest({
    id,
    name: id,
    description: 'test module',
    version: '1.0.0',
    icon: 'box',
    scope: 'shared',
    multiInstance: false,
    tile: { default: { w: 2, h: 2 }, min: { w: 1, h: 1 }, max: { w: 4, h: 4 } },
    settings: z.object({}),
    config: z.object({}),
    levels: ['view', 'edit'],
    jobs: [],
    publishes: [],
    subscribes: [],
    outbound: [],
    ...extra,
  });
}

export function serverFor(
  id: string,
  routes?: ModuleServer['routes'],
  extra: Omit<Partial<ModuleServer>, 'manifest'> & { manifest?: Partial<ModuleManifest> } = {},
): ModuleServer {
  const { manifest, ...rest } = extra;
  return defineServer({ manifest: manifestFor(id, manifest), ...(routes ? { routes } : {}), ...rest });
}

export interface Published { from: string; name: string; payload: unknown }

/** Fakes for the dependencies later tasks implement; records what the host sent them. */
export function fakeHostDeps(db: BetterSqlite3.Database, auth: Pick<AuthSeam, 'listUsers'>) {
  const published: Published[] = [];
  const pushed: Array<{ moduleId: string; instanceId: string | null; data: unknown }> = [];
  const notified: Array<{ moduleId: string; title: string }> = [];
  const deps = (manifest: ModuleManifest): HostDeps => ({
    manifest,
    db,
    http: () => ({ fetch: async <T>() => ({ status: 200, headers: {}, data: null as T, fromCache: false }) }),
    store: () => ({
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      keys: async () => [],
      blob: { put: async () => {}, get: async () => undefined, delete: async () => {} },
    }),
    bus: {
      publish: (from, name: EventName, payload) => void published.push({ from, name, payload }),
      subscribe: () => {},
    },
    snapshots: { push: (moduleId, instanceId, data) => void pushed.push({ moduleId, instanceId, data }) },
    notifications: {
      notify: (moduleId, n) => void notified.push({ moduleId, title: n.title }),
      privileged: () => undefined,
    },
    auth,
    state: { config: async () => ({}), instances: async () => [] },
    secrets: () => ({ get: async () => undefined, set: async () => {}, delete: async () => {} }),
    logger: silentLogger,
    now: () => new Date('2026-11-12T10:00:00.000Z'),
  });
  return { deps, published, pushed, notified };
}

export interface ModuleEnv {
  app: FastifyInstance;
  db: BetterSqlite3.Database;
  auth: ReturnType<typeof testAuth>;
  modules: LoadedModule[];
  fakes: ReturnType<typeof fakeHostDeps>;
}

/** db + loadModules (with createHost) + buildApp around the given inline modules. */
export async function makeModuleEnv(
  servers: Array<ModuleServer | (() => Promise<{ default: ModuleServer }>)>,
  authOpts: Parameters<typeof testAuth>[0] = {},
): Promise<ModuleEnv> {
  const db = openDb(':memory:');
  migrateCore(db);
  const auth = testAuth(authOpts);
  const fakes = fakeHostDeps(db, auth);
  const registry = servers.map((s) => (typeof s === 'function' ? s : async () => ({ default: s })));
  const modules = await loadModules(registry, db, {
    logger: silentLogger,
    makeHost: (s): HostServices => createHost(s.manifest.id, fakes.deps(s.manifest)),
  });
  const app = await buildApp({
    config: loadConfig({ NODE_ENV: 'test' }),
    db,
    auth,
    modules,
    webDistDir: new URL('.', import.meta.url).pathname,
    logger: false,
  });
  return { app, db, auth, modules, fakes };
}
