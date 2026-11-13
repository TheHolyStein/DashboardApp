import type BetterSqlite3 from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DashError, type ModuleId, type PermissionLevel, type UserId } from '@dash/contract';
import { parseWith, requireCsrf } from '../core/csrf.js';
import type { CoreSeam, SessionUser } from '../seams.js';
import { clientIp } from './ratelimit.js';

export type GrantListener = (userId: UserId, moduleId: ModuleId, level: PermissionLevel) => void;
export interface GrantRow {
  userId: UserId;
  moduleId: ModuleId;
  level: PermissionLevel;
}
export interface GrantsDeps {
  db: BetterSqlite3.Database;
  audit: CoreSeam['audit'];
  modules: () => Array<{ id: ModuleId; levels: ReadonlyArray<'view' | 'edit'> }>;
  /** Role of an enabled user; null when unknown or disabled. Must be cheap (cached by the caller). */
  userRole: (userId: UserId) => 'admin' | 'member' | null;
  /** Called when a listener throws. */
  logError?: (err: unknown) => void;
}

export interface Grants {
  levelFor: (userId: UserId, moduleId: ModuleId) => PermissionLevel;
  setGrant: (actor: SessionUser, input: { userId: UserId; moduleId: ModuleId; level: PermissionLevel }, ip?: string) => void;
  onGrantsChanged: (cb: GrantListener) => void;
  listGrants: () => GrantRow[];
  /** Deletes all stored rows of a (deleted) user. */
  removeUserGrants: (userId: UserId) => void;
  /** Drops the user's entries from the in-memory map only (call after the SQL delete has committed). */
  forgetUserGrants: (userId: UserId) => void;
  /**
   * Runs `mutate` (which must change the user's role, status or rows AND whatever backs `deps.userRole`),
   * then fires the callbacks for every module whose effective level for this user changed.
   * "Before" is snapshotted before `mutate`, "after" once it returned; if it throws nothing fires.
   */
  applyUserChange: (userId: UserId, mutate: () => void) => void;
}

const key = (userId: string, moduleId: string): string => `${userId}\u0000${moduleId}`;

export function createGrants(deps: GrantsDeps): Grants {
  const stored = new Map<string, PermissionLevel>();
  const listeners: GrantListener[] = [];
  for (const r of deps.db.prepare('SELECT user_id, module_id, level FROM grants').all() as Array<{
    user_id: string;
    module_id: string;
    level: PermissionLevel;
  }>) {
    stored.set(key(r.user_id, r.module_id), r.level);
  }

  const forget = (userId: UserId): void => {
    for (const k of [...stored.keys()]) if (k.startsWith(`${userId}\u0000`)) stored.delete(k);
  };

  const resolve = (
    role: 'admin' | 'member' | null,
    userId: UserId,
    mod: { levels: ReadonlyArray<'view' | 'edit'> } | undefined,
    moduleId: ModuleId,
  ): PermissionLevel => {
    if (role === null || !mod) return 'none';
    if (role === 'admin') return 'edit';
    const row = stored.get(key(userId, moduleId)) ?? 'none';
    if (row === 'edit') return mod.levels.includes('edit') ? 'edit' : mod.levels.includes('view') ? 'view' : 'none';
    if (row === 'view') return mod.levels.includes('view') ? 'view' : 'none';
    return 'none';
  };

  const fire = (userId: UserId, moduleId: ModuleId, level: PermissionLevel): void => {
    for (const cb of listeners) {
      try {
        cb(userId, moduleId, level);
      } catch (err) {
        deps.logError?.(err);
      }
    }
  };

  return {
    levelFor: (userId, moduleId) =>
      resolve(deps.userRole(userId), userId, deps.modules().find((m) => m.id === moduleId), moduleId),
    onGrantsChanged: (cb) => {
      listeners.push(cb);
    },
    listGrants: () =>
      [...stored].map(([k, level]) => {
        const [userId = '', moduleId = ''] = k.split('\u0000');
        return { userId, moduleId, level };
      }),
    removeUserGrants: (userId) => {
      deps.db.prepare('DELETE FROM grants WHERE user_id = ?').run(userId);
      forget(userId);
    },
    forgetUserGrants: forget,
    setGrant: (actor, input, ip) => {
      if (input.level !== 'none' && input.level !== 'view' && input.level !== 'edit') {
        throw new DashError('invalid', 'Level must be none, view or edit');
      }
      const role = deps.userRole(input.userId);
      if (role === null) throw new DashError('not_found', 'User not found');
      const mod = deps.modules().find((m) => m.id === input.moduleId);
      if (!mod) throw new DashError('not_found', 'Module not found');
      if (role === 'admin') throw new DashError('invalid', 'Admins always have edit access');
      if (input.level !== 'none' && !mod.levels.includes(input.level)) {
        throw new DashError('invalid', `Module ${input.moduleId} does not support level ${input.level}`);
      }
      const k = key(input.userId, input.moduleId);
      const before = resolve(role, input.userId, mod, input.moduleId);
      const oldStored = stored.get(k) ?? 'none';
      if (input.level === 'none') {
        deps.db.prepare('DELETE FROM grants WHERE user_id = ? AND module_id = ?').run(input.userId, input.moduleId);
        stored.delete(k);
      } else {
        deps.db
          .prepare(
            'INSERT INTO grants (user_id, module_id, level) VALUES (?, ?, ?) ON CONFLICT (user_id, module_id) DO UPDATE SET level = excluded.level',
          )
          .run(input.userId, input.moduleId, input.level);
        stored.set(k, input.level);
      }
      try {
        deps.audit({
          userId: actor.id,
          action: 'grant.change',
          detail: { target: input.userId, moduleId: input.moduleId, from: oldStored, to: input.level },
          ...(ip ? { ip } : {}),
        });
      } finally {
        // The effective level has already changed, so listeners hear about it even if the audit write failed.
        const after = resolve(role, input.userId, mod, input.moduleId);
        if (after !== before) fire(input.userId, input.moduleId, after);
      }
    },
    applyUserChange: (userId, mutate) => {
      const levels = (): Array<[ModuleId, PermissionLevel]> =>
        deps.modules().map((m) => [m.id, resolve(deps.userRole(userId), userId, m, m.id)]);
      const before = new Map(levels());
      mutate();
      for (const [moduleId, level] of levels()) if (before.get(moduleId) !== level) fire(userId, moduleId, level);
    },
  };
}

const GrantBody = z.object({
  userId: z.string().min(1).max(64),
  moduleId: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
  level: z.enum(['none', 'view', 'edit']),
});

function requireAdmin(req: FastifyRequest): SessionUser {
  if (!req.user) throw new DashError('unauthenticated', 'Authentication required');
  if (req.user.role !== 'admin') throw new DashError('forbidden', 'Admin only');
  return req.user;
}

export function registerGrantRoutes(app: FastifyInstance, grants: Grants): void {
  app.get('/api/admin/grants', (req) => {
    requireAdmin(req);
    return grants.listGrants();
  });
  app.put('/api/admin/grants', (req, reply) => {
    if (!req.user) throw new DashError('unauthenticated', 'Authentication required');
    requireCsrf(req);
    const user = requireAdmin(req);
    const body = parseWith(GrantBody, req.body);
    grants.setGrant(user, body, clientIp(req));
    return reply.status(204).send();
  });
}
