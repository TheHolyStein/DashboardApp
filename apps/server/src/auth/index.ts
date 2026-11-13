import type { ModuleId, PermissionLevel, UserId } from '@dash/contract';
import type { AuthSeam, CoreSeam } from '../seams.js';
import { createAuthPlugin, requireUserFrom, type LoginHooks } from './plugin.js';
import { createLoginLimiter, ipKey, RateLimitedError, userKey, type LoginLimiter } from './ratelimit.js';
import { listUsers, type verifyPassword } from './users.js';

export { purgeExpiredSessions } from './sessions.js';
export * from './users.js';
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

export function createAuth(core: CoreSeam, opts: CreateAuthOptions = {}): AuthSeam & { loginLimiter: LoginLimiter } {
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
  const grantListeners: Array<(userId: UserId, moduleId: ModuleId, level: PermissionLevel) => void> = [];

  // STUB until B4 (grants): admins edit everything, members get nothing.
  const levelFor = (userId: UserId): PermissionLevel => {
    const row = core.db.prepare('SELECT role FROM users WHERE id = ? AND disabled = 0').get(userId) as
      | { role: string }
      | undefined;
    return row?.role === 'admin' ? 'edit' : 'none';
  };

  return {
    plugin: createAuthPlugin({ core, now, levelFor, modules: opts.modules, login, verifyPassword: opts.verifyPassword }),
    requireUser: requireUserFrom,
    levelFor,
    // STUB until B4 (app passwords): no app password ever verifies.
    verifyAppPassword: () => null,
    // STUB until B4 (grants): callbacks are stored; nothing emits yet.
    onGrantsChanged: (cb) => {
      grantListeners.push(cb);
    },
    listUsers: () => listUsers(core.db),
    loginLimiter,
  };
}
