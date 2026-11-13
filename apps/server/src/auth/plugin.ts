import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { z } from 'zod';
import { DashError, type ModuleId, type PermissionLevel } from '@dash/contract';
import type { CoreSeam, SessionUser } from '../seams.js';
import { parseWith, requireCsrf } from '../core/csrf.js';
import { clientIp, RateLimitedError } from './ratelimit.js';
import {
  clearedCookie,
  createSession,
  deleteSession,
  hashSid,
  readSidCookie,
  resolveSession,
  sessionCookie,
} from './sessions.js';
import {
  findUserById,
  findUserByName,
  hashPassword,
  updatePrefs,
  verifyPassword,
  type UserRow,
} from './users.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth plugin on every request; null without a valid session. */
    user: SessionUser | null;
  }
}

/** What `GET /api/me` and the login response return (the contract's `MeDto`). */
export interface Me extends SessionUser {
  grants: Record<string, PermissionLevel>;
  csrf: string;
  prefs: UserRow['prefs'];
}

export interface LoginContext {
  /** The name as typed (not truncated). */
  name: string;
  ip: string;
  totp: string | undefined;
}

/**
 * Internal extension points of the login handler (rate limiting: B2, TOTP: B3). No logic lives here.
 * - `preCheck` runs before any password work; throw a DashError (e.g. `rate_limited`) to refuse.
 * - `onResult` runs after the password check and before the session is created. `user` is the matched
 *   user when `passwordOk`, else null. It may throw a DashError to refuse (e.g. missing TOTP code);
 *   it is also the place to record failures/successes for rate limiting.
 */
export interface LoginHooks {
  preCheck?(ctx: LoginContext): void | Promise<void>;
  onResult?(ctx: LoginContext & { user: UserRow | null; passwordOk: boolean }): void | Promise<void>;
}

export interface AuthPluginOpts {
  core: CoreSeam;
  now: () => Date;
  levelFor(userId: string, moduleId: ModuleId): PermissionLevel;
  modules?: (() => Array<{ id: ModuleId; levels: ReadonlyArray<'view' | 'edit'> }>) | undefined;
  login?: LoginHooks | undefined;
  /** Replaces argon2 verification (tests count calls). */
  verifyPassword?: typeof verifyPassword | undefined;
}

const UNAUTH_MESSAGE = 'Invalid name or password';

const LoginBody = z.object({
  name: z.string().min(1).max(256),
  password: z.string().min(1).max(256),
  totp: z.string().max(16).optional(),
});

const timeZones = new Set<string>(['UTC', ...Intl.supportedValuesOf('timeZone')]);
const PrefsPatch = z
  .object({
    theme: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
    modePolicy: z.enum(['day', 'night', 'system', 'sun']),
    locale: z.string().min(1).max(10),
    timeZone: z.string().refine((tz) => timeZones.has(tz), 'Unknown time zone'),
  })
  .partial()
  .strict();

let dummyHash: Promise<string> | undefined;
/** Fixed hash verified when the user does not exist or is disabled, so all failures cost one verify. */
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword('dummy-password-for-timing-equalisation');
  return dummyHash;
}

export function createAuthPlugin(opts: AuthPluginOpts): FastifyPluginAsync {
  const { core, now } = opts;
  const verify = opts.verifyPassword ?? verifyPassword;
  const db = core.db;

  const toMe = (user: SessionUser, csrf: string): Me => {
    const row = findUserById(db, user.id);
    const grants: Record<string, PermissionLevel> = {};
    for (const m of opts.modules?.() ?? []) grants[m.id] = opts.levelFor(user.id, m.id);
    return {
      id: user.id,
      name: user.name,
      handle: user.handle,
      role: user.role,
      grants,
      csrf,
      prefs: row?.prefs ?? { theme: 'default', modePolicy: 'system', locale: 'en', timeZone: 'UTC' },
    };
  };

  const plugin: FastifyPluginAsync = (app) => {
    app.decorateRequest('user', null);
    app.decorateRequest('session', null);

    app.addHook('onRequest', (req, _reply, done) => {
      const sid = readSidCookie(req.headers.cookie);
      const resolved = sid ? resolveSession(db, sid, now()) : null;
      if (resolved) {
        req.user = resolved.user;
        req.session = { csrf: resolved.csrf };
      }
      done();
    });

    app.post('/api/auth/login', async (req, reply) => {
      const ct = req.headers['content-type'];
      if (typeof ct !== 'string' || !ct.toLowerCase().startsWith('application/json')) {
        throw new DashError('invalid', 'Content-Type must be application/json');
      }
      const body = parseWith(LoginBody, req.body);
      const ip = clientIp(req);
      const ctx: LoginContext = { name: body.name, ip, totp: body.totp };
      const attempted = body.name.slice(0, 64);

      try {
        await opts.login?.preCheck?.(ctx);
      } catch (err) {
        if (err instanceof RateLimitedError) void reply.header('Retry-After', String(err.retryAfterSec));
        throw err;
      }

      const found = findUserByName(db, body.name.trim());
      const user = found && !found.disabled ? found : null;
      const passwordOk = await verify(user ? user.passwordHash : await getDummyHash(), body.password);
      const ok = user !== null && passwordOk;

      try {
        await opts.login?.onResult?.({ ...ctx, user: ok ? user : null, passwordOk: ok });
      } catch (err) {
        core.audit({ userId: user?.id ?? null, action: 'auth.login.failure', detail: { name: attempted }, ip });
        throw err;
      }
      if (!ok) {
        core.audit({ userId: null, action: 'auth.login.failure', detail: { name: attempted }, ip });
        throw new DashError('unauthenticated', UNAUTH_MESSAGE);
      }

      const ua = req.headers['user-agent'];
      const { sid, csrf } = createSession(db, user.id, now(), { ua: typeof ua === 'string' ? ua : undefined, ip });
      core.audit({ userId: user.id, action: 'auth.login.success', ip });
      void reply.header('Set-Cookie', sessionCookie(sid));
      return toMe(user, csrf);
    });

    app.post('/api/auth/logout', async (req, reply) => {
      const user = requireUserFrom(req);
      requireCsrf(req);
      const sid = readSidCookie(req.headers.cookie);
      if (sid) deleteSession(db, hashSid(sid));
      core.audit({ userId: user.id, action: 'auth.logout', ip: clientIp(req) });
      void reply.header('Set-Cookie', clearedCookie());
      return reply.status(204).send();
    });

    app.get('/api/me', (req) => {
      const user = requireUserFrom(req);
      return toMe(user, req.session?.csrf ?? '');
    });

    app.patch('/api/me/prefs', (req) => {
      const user = requireUserFrom(req);
      requireCsrf(req);
      const patch = parseWith(PrefsPatch, req.body);
      updatePrefs(db, user.id, patch);
      return toMe(user, req.session?.csrf ?? '');
    });
    return Promise.resolve();
  };

  return fp(plugin, { name: 'dash-auth' });
}

export function requireUserFrom(req: FastifyRequest): SessionUser {
  if (!req.user) throw new DashError('unauthenticated', 'Authentication required');
  return req.user;
}
