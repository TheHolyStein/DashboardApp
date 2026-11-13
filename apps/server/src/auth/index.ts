import type { ModuleId, UserId } from '@dash/contract';
import type { AuthSeam, CoreSeam } from '../seams.js';
import { createAuthPlugin, requireUserFrom, type LoginHooks } from './plugin.js';
import { createLoginLimiter, ipKey, RateLimitedError, userKey, type LoginLimiter } from './ratelimit.js';
import { createGrants, type Grants } from './grants.js';
import { listUsers, type verifyPassword } from './users.js';

export { purgeExpiredSessions } from './sessions.js';
export * from './users.js';
export type { GrantRow } from './grants.js';
export { clientIp, createLoginLimiter, type LoginLimiter } from './ratelimit.js';
export type { LoginHooks, LoginContext } from './plugin.js';

export interface CreateAuthOptions {
  now?: () => Date;
  hooks?: { onUserCreated?(userId: UserId): void };
  /** Modules whose levels `MeDto.grants` reports; empty object when not supplied. */
  modules?: () => Array<{ id: ModuleId; levels: ReadonlyArray<'view' | 'edit'> }>;
  /** Internal extension points of the login handler (rate limiting B2, TOTP B3). */
  login?: LoginHooks;
  /** Replaces argon2 verification (tests). */
  verifyPassword?: typeof verifyPassword;
}

export type Auth = AuthSeam & {
  loginLimiter: LoginLimiter;
  grants: Grants;
  /** Drops the cached role of a user (call after create, role change, disable, delete). */
  invalidateUser: (userId: UserId) => void;
  /** Invalidates the role cache and fires `onGrantsChanged` for each module whose effective level changed. */
  notifyUserChanged: (userId: UserId) => void;
  removeUserGrants: (userId: UserId) => void;
};

export function createAuth(core: CoreSeam, opts: CreateAuthOptions = {}): Auth {
  const now = opts.now ?? (() => new Date());
  const loginLimiter = createLoginLimiter({
    db: core.db,
    now,
    onLock: ({ key, kind, lockSec }) =>
      core.audit({
        userId: null,
        action: 'auth.lockout',
        detail: { key: kind, lockSec },
        ...(kind === 'ip' ? { ip: key.slice('ip:'.length) } : {}),
      }),
  });
  // Rate limiting runs around the caller's hooks: refuse locked keys first (no password work), and
  // count a failure whenever the password or a later hook (e.g. TOTP) refuses the attempt.
  const login: LoginHooks = {
    preCheck: async (ctx) => {
      const verdict = loginLimiter.check([ipKey(ctx.ip), userKey(ctx.name)]);
      if (!verdict.allowed) throw new RateLimitedError(verdict.retryAfterSec);
      await opts.login?.preCheck?.(ctx);
    },
    onResult: async (ctx) => {
      let refusal: Error | undefined;
      try {
        await opts.login?.onResult?.(ctx);
      } catch (err) {
        refusal = err instanceof Error ? err : new Error(String(err));
      }
      if (refusal === undefined && ctx.passwordOk) loginLimiter.recordSuccess(userKey(ctx.name));
      else loginLimiter.recordFailure([ipKey(ctx.ip), userKey(ctx.name)]);
      if (refusal !== undefined) throw refusal;
    },
  };
  // Role cache: only enabled users are cached; invalidate on create, role change, disable and delete.
  const roleCache = new Map<UserId, 'admin' | 'member'>();
  const userRole = (userId: UserId): 'admin' | 'member' | null => {
    const hit = roleCache.get(userId);
    if (hit) return hit;
    const row = core.db.prepare('SELECT role FROM users WHERE id = ? AND disabled = 0').get(userId) as
      | { role: 'admin' | 'member' }
      | undefined;
    if (!row) return null;
    roleCache.set(userId, row.role);
    return row.role;
  };
  const invalidateUser = (userId: UserId): void => {
    roleCache.delete(userId);
  };
  const grants = createGrants({
    db: core.db,
    audit: (entry) => core.audit(entry),
    modules: opts.modules ?? (() => []),
    userRole,
    logError: (err) => console.error('onGrantsChanged callback failed', err),
  });
  /** Invalidates the role cache and fires `onGrantsChanged` for every module whose effective level changed. */
  const notifyUserChanged = (userId: UserId): void => {
    const beforeRole = roleCache.get(userId);
    invalidateUser(userId);
    grants.notifyUserChanged(userId, beforeRole);
  };
  const levelFor = grants.levelFor;

  return {
    plugin: createAuthPlugin({ core, now, levelFor, grants, modules: opts.modules, login, verifyPassword: opts.verifyPassword }),
    requireUser: requireUserFrom,
    levelFor,
    // STUB until B4 (app passwords): no app password ever verifies.
    verifyAppPassword: () => null,
    onGrantsChanged: grants.onGrantsChanged,
    listUsers: () => listUsers(core.db),
    loginLimiter,
    grants,
    invalidateUser,
    notifyUserChanged,
    removeUserGrants: grants.removeUserGrants,
  };
}
