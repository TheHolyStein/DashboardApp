/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
// Enabling a module that was disabled at startup runs its setup first.
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { HostServices } from '@dash/contract';
import { registerAdminModuleRoutes } from '../../src/core/admin-modules.ts';
import { openDb } from '../../src/core/db.ts';
import { errorHandler } from '../../src/core/errors.ts';
import { migrateCore } from '../../src/core/migrate.ts';
import { loadModules, type LoadedModule } from '../../src/core/modules/loader.ts';
import { testAuth } from './helpers.ts';
import { serverFor, silentLogger } from './module-env.ts';
import { USERS } from './pages-env.ts';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function env(setup: (host: HostServices) => void | Promise<void>) {
  const db = openDb(':memory:');
  migrateCore(db);
  db.prepare('INSERT INTO module_state (module_id, enabled) VALUES (?, 0)').run('late');
  const setupOn = vi.fn(setup);
  const eager = vi.fn();
  const modules: LoadedModule[] = await loadModules(
    [
      async () => ({ default: serverFor('late', undefined, { setup: setupOn }) }),
      async () => ({ default: serverFor('early', undefined, { setup: eager }) }),
    ],
    db,
    { logger: silentLogger, makeHost: () => ({}) as HostServices },
  );
  const registered: Array<{ id: string; enabled: boolean }> = [];
  const errors: unknown[] = [];
  const setupCallsAtRegister: number[] = [];
  const auth = testAuth({ users: USERS });
  app = Fastify();
  app.setErrorHandler(errorHandler);
  await app.register(auth.plugin);
  registerAdminModuleRoutes(app, {
    db,
    auth,
    modules,
    scheduler: { syncInstances: () => {}, register: (m) => {
        registered.push({ id: m.id, enabled: m.enabled });
        setupCallsAtRegister.push(m.id === 'late' ? setupOn.mock.calls.length : -1);
      } },
    stream: { sendToUser: () => {}, sendSnapshot: () => {} },
    now: () => new Date('2026-11-12T10:00:00.000Z'),
    logger: { ...silentLogger, error: (...a: unknown[]) => void errors.push(a) },
    audit: () => {},
  });
  const put = async (id: string, enabled: boolean) => {
    const res = await app!.inject({
      method: 'PUT',
      url: `/api/admin/modules/${id}/enabled`,
      headers: { 'x-test-user': 'root', 'x-csrf': 'csrf-root' },
      payload: { enabled },
    });
    return { status: res.statusCode, json: res.json<any>() };
  };
  return { db, modules, registered, setupCallsAtRegister, errors, setupOn, eager, put };
}

describe('enabling a module that was disabled at startup', () => {
  it('runs setup before registering it with the scheduler, and only once', async () => {
    const e = await env(async () => {});
    expect(e.setupOn).not.toHaveBeenCalled(); // the loader skips disabled modules
    const res = await e.put('late', true);
    expect(res).toEqual({ status: 200, json: { id: 'late', enabled: true } });
    expect(e.setupOn).toHaveBeenCalledOnce();
    expect(e.setupCallsAtRegister.at(-1)).toBe(1); // setup had already run when the scheduler got the module
    expect(e.registered.at(-1)).toEqual({ id: 'late', enabled: true });
    await e.put('late', false);
    await e.put('late', true);
    expect(e.setupOn).toHaveBeenCalledOnce();
  });

  it('does not set up again a module that was enabled at startup', async () => {
    const e = await env(async () => {});
    expect(e.eager).toHaveBeenCalledOnce(); // by the loader
    await e.put('early', false);
    await e.put('early', true);
    expect(e.eager).toHaveBeenCalledOnce();
  });

  it('keeps the module disabled and failed when setup throws, and answers 500 with the reason', async () => {
    const e = await env(async () => {
      throw new Error('no such table');
    });
    const res = await e.put('late', true);
    expect(res.status).toBe(500);
    expect(res.json.error).toEqual({ code: 'internal', message: 'Module setup failed: no such table' });
    const mod = e.modules.find((m) => m.id === 'late')!;
    expect(mod.enabled).toBe(false);
    expect(mod.failed).toContain('setup failed');
    expect(e.registered).toEqual([]); // never handed to the scheduler
    expect(e.db.prepare("SELECT enabled FROM module_state WHERE module_id = 'late'").pluck().get()).toBe(0);
    expect(e.errors).toHaveLength(1);
    const list = await app!.inject({ method: 'GET', url: '/api/admin/modules', headers: { 'x-test-user': 'root' } });
    expect(list.json<any[]>().find((m: any) => m.id === 'late')).toMatchObject({ enabled: false, failed: true });
    expect((await e.put('late', true)).status).toBe(404); // failed modules are not addressable until a restart
  });
});
