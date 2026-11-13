import type { ModuleId, UserId } from '@dash/contract';
import type { AuthSeam, CoreSeam } from '../seams.js';
import { createAuthPlugin, requireUserFrom, type LoginHooks } from './plugin.js';
import {
  createLoginLimiter,
  ipKey,
  RateLimitedError,
  userKey,
  type AttemptTicket,
  type LoginLimiter,
} from './ratelimit.js';
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
  /**
   * Modules (id and supported levels) that grants and `MeDto.grants` cover. Without it every module is
   * unknown and `levelFor` returns `none` for everyone, admins included (fail-closed), so the wiring passes it.
   */
  modules?: () => Array<{ id: ModuleId; levels: ReadonlyArray<'view' | 'edit'> }>;
  /** Internal extension points of the login handler (rate limiting B2, TOTP B3). */
  login?: LoginHooks;
  /** Replaces argon2 verification (tests). */
  verifyPassword?: typeof verifyPassword;
}

export type Auth = AuthSeam & {
  loginLimiter: LoginLimiter;
  grants: Grants;
  /** Runs a user mutation, refreshes the role cache and fires `onGrantsChanged` for changed levels. */
  applyUserChange: (userId: UserId, mutate: () => void) => void;
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
  // Rate limiting: the attempt is counted atomically BEFORE password verification (`reserve`), so a
  // concurrent burst cannot out-run the limit; a wrong password or a refusal by a later hook (e.g.
  // TOTP) needs nothing more. A right password settles the reservation (`recordSuccess`), which
  // refuses the login if another request of a burst locked a key in the meantime.
  const TICKET = 'loginTicket';
  const login: LoginHooks = {
    preCheck: async (ctx) => {
      const reservation = loginLimiter.reserve([ipKey(ctx.ip), userKey(ctx.name)]);
      if (!reservation.allowed) throw new RateLimitedError(reservation.retryAfterSec);
      ctx.state[TICKET] = reservation.ticket;
      await opts.login?.preCheck?.(ctx);
    },
    onResult: async (ctx) => {
      await opts.login?.onResult?.(ctx);
      const ticket = ctx.state[TICKET] as AttemptTicket | undefined;
      if (ctx.passwordOk && ticket) {
        const settled = loginLimiter.recordSuccess(ticket);
        if (!settled.allowed) throw new RateLimitedError(settled.retryAfterSec);
      }
    },
  };
  // Role cache: authoritative. Loaded once with every enabled user; a user absent from it has no role
  // (unknown or disabled). It only changes through `applyUserChange`.
  const roleCache = new Map<UserId, 'admin' | 'member'>();
  const loadRole = (userId: UserId): void => {
    const row = core.db.prepare('SELECT role FROM users WHERE id = ? AND disabled = 0').get(userId) as
      | { role: 'admin' | 'member' }
      | undefined;
    if (row) roleCache.set(userId, row.role);
    else roleCache.delete(userId);
  };
  for (const r of core.db.prepare('SELECT id, role FROM users WHERE disabled = 0').all() as Array<{
    id: UserId;
    role: 'admin' | 'member';
  }>) {
    roleCache.set(r.id, r.role);
  }
  const userRole = (userId: UserId): 'admin' | 'member' | null => roleCache.get(userId) ?? null;
  const grants = createGrants({
    db: core.db,
    audit: (entry) => core.audit(entry),
    modules: opts.modules ?? (() => []),
    userRole,
    logError: (err) => console.error('onGrantsChanged callback failed', err),
  });
  /**
   * The only way users change (create, role change, disable, enable, delete): `mutate` performs the
   * database change; the role cache is refreshed from the database afterwards and `onGrantsChanged`
   * fires for every module whose effective level changed. Wire it into `UserDeps.applyChange`.
   */
  const applyUserChange = (userId: UserId, mutate: () => void): void => {
    grants.applyUserChange(userId, () => {
      mutate();
      loadRole(userId);
    });
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
    applyUserChange,
    removeUserGrants: grants.removeUserGrants,
  };
}
