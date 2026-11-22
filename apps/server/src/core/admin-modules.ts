// Admin module API: list, config, enable/disable. Admin role only; every change is audited.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DashError } from '@dash/contract';
import type { CoreSeam, SessionUser } from '../seams.js';
import { parseWith, secured } from './csrf.js';
import { moduleOf, pageAudience, type CoreRouteDeps, type PageRow } from './instances.js';
import type { LoadedModule, Scheduler } from './modules/deps.js';
import { SETUP_TIMEOUT_MS, teardownModule, withTimeout } from './modules/loader.js';

export interface AdminModuleDeps extends CoreRouteDeps {
  scheduler: Pick<Scheduler, 'syncInstances' | 'register'>;
  audit: CoreSeam['audit'];
}

const EnabledBody = z.object({ enabled: z.boolean() });

function requireAdmin(user: SessionUser): void {
  if (user.role !== 'admin') throw new DashError('forbidden', 'Administrator access required');
}

const hasConfig = (mod: LoadedModule): boolean =>
  mod.failed === undefined && Object.keys((mod.server.manifest.config as z.ZodObject).shape).length > 0;

/**
 * `GET /api/admin/modules`, `GET|PUT /api/admin/modules/:id/config`, `PUT /api/admin/modules/:id/enabled`.
 * Disabling flips `mod.enabled` (the router reads it per request), re-registers the module with the scheduler (which
 * then drops its jobs), and tells every user's streams (`revoked` for the module plus a `layout` event for each
 * affected page); enabling does the reverse. A module that was disabled when the server started was never set up
 * (the loader only runs `setup` for enabled modules): enabling it runs `setup(host)` first. If that throws, the module
 * stays disabled and is marked failed (like a load failure), the error is logged, and the request answers
 * 500 `internal` with the message "Module setup failed: <reason>", which the admin screen shows. A restart retries.
 * Enable and disable of one module are serialised on a per-module promise chain (`lifecycle.run`; errors do not
 * break the chain): a setup never overlaps a teardown, a second enable finds the module already set up (setup never
 * runs twice), and a disable that arrives while a setup is queued or running waits behind it, disables, and then
 * runs `teardown` (so setup and teardown stay balanced).
 * `Stream.disconnectUser(user, module)` is deliberately not used: it mutes the module on open connections until they
 * reconnect, which would hide a re-enabled module.
 */
export function registerAdminModuleRoutes(app: FastifyInstance, deps: AdminModuleDeps): void {
  const { db, auth } = deps;
  // One promise chain per module id: enable, disable and teardown of a module run strictly one after the other
  // (a failure does not break the chain), so a setup never overlaps a teardown.
  const chains = new Map<string, Promise<unknown>>();
  const lifecycle = {
    run<T>(moduleId: string, fn: () => Promise<T>): Promise<T> {
      const result = (chains.get(moduleId) ?? Promise.resolve()).then(fn);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      chains.set(moduleId, tail);
      void tail.then(() => {
        if (chains.get(moduleId) === tail) chains.delete(moduleId);
      });
      return result;
    },
  };
  // Enables that are queued or running and may still run `setup`: a disable that finds one waits behind it and
  // then tears the module down again.
  const setupsQueued = new Map<string, number>();
  const queued = (id: string): number => setupsQueued.get(id) ?? 0;

  const ensureSetUp = async (mod: LoadedModule): Promise<void> => {
    if (mod.setupRan) return;
    try {
      await withTimeout(() => mod.server.setup?.(mod.host), SETUP_TIMEOUT_MS, 'setup');
      mod.setupRan = true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      mod.enabled = false;
      mod.failed = `setup failed: ${reason}`;
      deps.logger.error({ module: mod.id, reason }, 'module setup failed on enable');
      throw new DashError('internal', `Module setup failed: ${reason}`);
    }
  };

  const find = (id: string): LoadedModule => {
    const mod = moduleOf(deps, id);
    if (!mod || mod.failed !== undefined) throw new DashError('not_found', 'Module not found');
    return mod;
  };

  secured(app, auth, 'GET', '/api/admin/modules', (user) => {
    requireAdmin(user);
    return deps.modules.map((m) => {
      const man = m.server.manifest;
      return {
        id: m.id,
        name: man.name ?? m.id,
        description: man.description ?? '',
        version: man.version ?? '',
        enabled: m.failed === undefined && m.enabled,
        failed: m.failed !== undefined,
        levels: m.failed === undefined ? [...man.levels] : [],
        hasConfig: hasConfig(m),
      };
    });
  });

  secured(app, auth, 'GET', '/api/admin/modules/:id/config', (user, req) => {
    requireAdmin(user);
    const mod = find((req.params as { id: string }).id);
    const raw = db.prepare('SELECT config FROM module_state WHERE module_id = ?').pluck().get(mod.id) as string | undefined;
    const stored = raw === undefined ? {} : (JSON.parse(raw) as unknown);
    const parsed = mod.server.manifest.config.safeParse(stored);
    return parsed.success ? parsed.data : stored;
  });

  secured(app, auth, 'PUT', '/api/admin/modules/:id/config', (user, req) => {
    requireAdmin(user);
    const mod = find((req.params as { id: string }).id);
    const config = parseWith(mod.server.manifest.config, req.body, 'config');
    db.prepare(
      `INSERT INTO module_state (module_id, config) VALUES (?, ?)
       ON CONFLICT(module_id) DO UPDATE SET config = excluded.config`,
    ).run(mod.id, JSON.stringify(config));
    // Values are not logged: only which keys changed.
    deps.audit({
      userId: user.id,
      action: 'admin.module.config',
      detail: { moduleId: mod.id, keys: typeof config === 'object' && config !== null ? Object.keys(config) : [] },
      ip: req.ip,
    });
    return config;
  });

  const apply = (mod: LoadedModule, enabled: boolean, user: SessionUser, ip: string): { id: string; enabled: boolean } => {
    db.prepare(
      `INSERT INTO module_state (module_id, enabled) VALUES (?, ?)
       ON CONFLICT(module_id) DO UPDATE SET enabled = excluded.enabled`,
    ).run(mod.id, enabled ? 1 : 0);
    mod.enabled = enabled;
    deps.scheduler.register(mod);
    deps.scheduler.syncInstances(mod.id);

    const pages = db
      .prepare(
        `SELECT DISTINCT p.* FROM pages p JOIN instances i ON i.page_id = p.id WHERE i.module_id = ?`,
      )
      .all(mod.id) as PageRow[];
    const users = auth.listUsers().map((u) => u.id);
    if (!enabled) for (const uid of users) deps.stream.sendToUser(uid, { type: 'revoked', moduleId: mod.id });
    for (const page of pages) {
      for (const uid of pageAudience(deps, page)) deps.stream.sendToUser(uid, { type: 'layout', pageId: page.id });
    }
    deps.audit({
      userId: user.id,
      action: enabled ? 'admin.module.enable' : 'admin.module.disable',
      detail: { moduleId: mod.id },
      ip,
    });
    return { id: mod.id, enabled };
  };

  secured(app, auth, 'PUT', '/api/admin/modules/:id/enabled', (user, req) => {
    requireAdmin(user);
    const mod = find((req.params as { id: string }).id);
    const { enabled } = parseWith(EnabledBody, req.body);
    if (enabled) {
      const tracked = !mod.setupRan || queued(mod.id) > 0; // this enable may run `setup`
      if (tracked) setupsQueued.set(mod.id, queued(mod.id) + 1);
      return lifecycle.run(mod.id, async () => {
        try {
          await ensureSetUp(mod);
        } finally {
          if (tracked) {
            if (queued(mod.id) > 1) setupsQueued.set(mod.id, queued(mod.id) - 1);
            else setupsQueued.delete(mod.id);
          }
        }
        return apply(mod, true, user, req.ip);
      });
    }
    const midSetup = queued(mod.id) > 0; // a setup is queued or running: it ends up with a teardown
    return lifecycle.run(mod.id, async () => {
      const result = apply(mod, false, user, req.ip);
      if (midSetup) await teardownModule(mod, deps.logger);
      return result;
    });
  });
}
