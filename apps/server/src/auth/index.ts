import type { ModuleId, PermissionLevel, UserId } from '@dash/contract';
import type { AuthSeam, CoreSeam } from '../seams.js';
import { createAuthPlugin, requireUserFrom, type LoginHooks } from './plugin.js';
import { listUsers } from './users.js';

export { purgeExpiredSessions } from './sessions.js';
export * from './users.js';
export type { LoginHooks, LoginContext } from './plugin.js';

export interface CreateAuthOptions {
  now?: () => Date;
  hooks?: { onUserCreated?(userId: UserId): void };
  /** Modules whose levels `MeDto.grants` reports; empty object when not supplied. */
  modules?: () => Array<{ id: ModuleId; levels: ReadonlyArray<'view' | 'edit'> }>;
  /** Internal extension points of the login handler (rate limiting B2, TOTP B3). */
  login?: LoginHooks;
}

export function createAuth(core: CoreSeam, opts: CreateAuthOptions = {}): AuthSeam {
  const now = opts.now ?? (() => new Date());
  const grantListeners: Array<(userId: UserId, moduleId: ModuleId, level: PermissionLevel) => void> = [];

  // STUB until B4 (grants): admins edit everything, members get nothing.
  const levelFor = (userId: UserId): PermissionLevel => {
    const row = core.db.prepare('SELECT role FROM users WHERE id = ? AND disabled = 0').get(userId) as
      | { role: string }
      | undefined;
    return row?.role === 'admin' ? 'edit' : 'none';
  };

  return {
    plugin: createAuthPlugin({ core, now, levelFor, modules: opts.modules, login: opts.login }),
    requireUser: requireUserFrom,
    levelFor,
    // STUB until B4 (app passwords): no app password ever verifies.
    verifyAppPassword: () => null,
    // STUB until B4 (grants): callbacks are stored; nothing emits yet.
    onGrantsChanged: (cb) => {
      grantListeners.push(cb);
    },
    listUsers: () => listUsers(core.db),
  };
}
