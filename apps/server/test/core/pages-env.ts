// Harness for the pages/instances/notifications/admin tests: real db, real services, fake scheduler/stream/bus.
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unnecessary-type-assertion */
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { HostServices, ModuleInstance } from '@dash/contract';
import type BetterSqlite3 from 'better-sqlite3';
import { createAudit } from '../../src/core/audit.ts';
import { buildApp } from '../../src/core/app.ts';
import { loadConfig } from '../../src/core/config.ts';
import { openDb } from '../../src/core/db.ts';
import { createInstanceReader, createModuleState } from '../../src/core/instances.ts';
import { migrateCore } from '../../src/core/migrate.ts';
import { createHost } from '../../src/core/modules/host.ts';
import { loadModules, type LoadedModule } from '../../src/core/modules/loader.ts';
import type { StreamEvent } from '../../src/core/modules/deps.ts';
import { createNotifications, type NotificationsService } from '../../src/core/notifications.ts';
import type { SessionUser } from '../../src/seams.ts';
import { testAuth } from './helpers.ts';
import { serverFor, silentLogger } from './module-env.ts';


export const USERS: Record<string, SessionUser> = {
  alice: { id: 'alice', name: 'Alice', handle: 'alice', role: 'member' },
  bob: { id: 'bob', name: 'Bob', handle: 'bob', role: 'member' },
  root: { id: 'root', name: 'Root', handle: 'root', role: 'admin' },
};

export const clock = { now: new Date('2026-11-12T10:00:00.000Z') };

export interface Env {
  app: FastifyInstance;
  db: BetterSqlite3.Database;
  auth: ReturnType<typeof testAuth>;
  modules: LoadedModule[];
  notifications: NotificationsService;
  changes: Array<{ kind: string; moduleId: string; instance: ModuleInstance }>;
  synced: string[];
  registered: Array<{ id: string; enabled: boolean }>;
  streamed: Array<{ userId: string; ev: StreamEvent }>;
  published: Array<{ from: string; name: string; payload: unknown }>;
  audits: Array<{ userId: string | null; action: string; detail?: object }>;
  call(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    as: string | null,
    body?: unknown,
  ): Promise<{ status: number; json: any }>;
}

export async function makeEnv(opts: { failOnChange?: boolean } = {}): Promise<Env> {
  clock.now = new Date('2026-11-12T10:00:00.000Z');
  const db = openDb(':memory:');
  migrateCore(db);
  const auth = testAuth({ users: USERS });
  const changes: Env['changes'] = [];
  const synced: string[] = [];
  const registered: Env['registered'] = [];
  const streamed: Env['streamed'] = [];
  const published: Env['published'] = [];
  const audits: Env['audits'] = [];
  const now = (): Date => clock.now;

  const hook = (id: string) => async (kind: 'added' | 'updated' | 'removed', instance: ModuleInstance) => {
    changes.push({ kind, moduleId: id, instance });
    if (opts.failOnChange) throw new Error('hook boom');
  };
  const demo = serverFor('demo', undefined, {
    manifest: { settings: z.object({ city: z.string().default('Berlin'), n: z.number().int().optional() }) },
    onInstanceChange: hook('demo'),
  });
  const multi = serverFor('multi', undefined, { manifest: { multiInstance: true }, onInstanceChange: hook('multi') });
  const secret = serverFor('secret', undefined, { manifest: { multiInstance: true } });
  const cfg = serverFor('cfgmod', undefined, {
    manifest: { config: z.object({ apiBase: z.string().default('x'), limit: z.number().int().min(1).default(5) }) },
  });

  const bus = {
    publish: (from: string, name: string, payload: unknown) => void published.push({ from, name, payload }),
    subscribe: () => {},
  };
  const stream = {
    sendToUser: (userId: string, ev: StreamEvent) => void streamed.push({ userId, ev }),
    sendSnapshot: () => {},
  };
  const notifications = createNotifications({
    db,
    auth,
    bus: bus as never,
    stream,
    now,
    logger: silentLogger,
  });
  const state = createModuleState(db);
  const modules = await loadModules([async () => ({ default: demo }), async () => ({ default: multi }), async () => ({ default: secret }), async () => ({ default: cfg })], db, {
    logger: silentLogger,
    makeHost: (s): HostServices =>
      createHost(s.manifest.id, {
        manifest: s.manifest,
        db,
        http: () => ({ fetch: async () => { throw new Error('no network'); } }),
        store: () => ({}) as never,
        bus: bus as never,
        snapshots: { push: () => {} },
        notifications,
        auth,
        state,
        secrets: () => ({}) as never,
        logger: silentLogger,
        now,
      }),
  });
  const audit = createAudit(db, now);
  const app = await buildApp({
    config: loadConfig({ NODE_ENV: 'test' }),
    db,
    auth,
    modules,
    webDistDir: new URL('.', import.meta.url).pathname,
    logger: false,
    pagesApi: {
      scheduler: {
        syncInstances: (id: string) => void synced.push(id),
        register: (m: LoadedModule) => void registered.push({ id: m.id, enabled: m.enabled }),
      },
      stream,
      notifications,
      audit: (e) => {
        audits.push(e);
        audit(e);
      },
      now,
    },
  });
  const call: Env['call'] = async (method, url, as, body) => {
    const res = await app.inject({
      method,
      url,
      headers: as ? { 'x-test-user': as, 'x-csrf': `csrf-${as}` } : {},
      ...(body === undefined ? {} : { payload: body as object }),
    });
    return { status: res.statusCode, json: res.body ? (JSON.parse(res.body) as unknown) : undefined } as never;
  };
  return { app, db, auth, modules, notifications, changes, synced, registered, streamed, published, audits, call };
}

export { createInstanceReader };
