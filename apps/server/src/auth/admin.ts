import type BetterSqlite3 from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DashError, type UserId } from '@dash/contract';
import { parseWith, requireCsrf } from '../core/csrf.js';
import type { CoreSeam, SessionUser } from '../seams.js';
import type { AppPasswords } from './app-passwords.js';
import { requireUserFrom } from './plugin.js';
import { clientIp, RateLimitedError, type LoginLimiter } from './ratelimit.js';
import { hashSid, readSidCookie } from './sessions.js';
import type { Totp } from './totp.js';
import { createUser, findUserById, handleFor, hashPassword, validatePassword, type UserDeps, type verifyPassword } from './users.js';

/** Everything the user-admin, TOTP and app-password routes need. */
export interface AuthRouteCtx {
  core: CoreSeam;
  db: BetterSqlite3.Database;
  now: () => Date;
  /** `createUser` dependencies: core, `onUserCreated` and `applyChange` wired. */
  userDeps: UserDeps;
  applyUserChange: (userId: UserId, mutate: () => void) => void;
  removeUserGrants: (userId: UserId) => void;
  forgetUserGrants: (userId: UserId) => void;
  verify: typeof verifyPassword;
  limiter: LoginLimiter;
  totp: Totp;
  appPasswords: AppPasswords;
}

interface Row {
  id: string;
  name: string;
  handle: string;
  role: 'admin' | 'member';
  disabled: number;
  totp_secret_enc: string | null;
  created_at: string;
}

function toDto(c: AuthRouteCtx, r: Row): Record<string, unknown> {
  return {
    id: r.id,
    name: r.name,
    handle: r.handle,
    role: r.role,
    disabled: r.disabled !== 0,
    totpEnabled: c.totp.isEnabled(r.id, r.totp_secret_enc),
    createdAt: r.created_at,
  };
}

const COLUMNS = 'id, name, handle, role, disabled, totp_secret_enc, created_at';

function requireAdmin(req: FastifyRequest): SessionUser {
  const user = requireUserFrom(req);
  requireCsrf(req);
  if (user.role !== 'admin') throw new DashError('forbidden', 'Admin only');
  return user;
}

/**
 * Verifies the signed-in user's own password for sensitive actions. Attempts are counted with the login
 * limiter (key `user:#pw-<id>`, which no sign-in name can produce) so a stolen session cannot guess it.
 */
export async function checkOwnPassword(c: AuthRouteCtx, userId: UserId, password: string): Promise<void> {
  const reservation = c.limiter.reserve([`user:#pw-${userId}`]);
  if (!reservation.allowed) throw new RateLimitedError(reservation.retryAfterSec);
  const row = findUserById(c.db, userId);
  const ok = row ? await c.verify(row.passwordHash, password) : false;
  if (!ok) throw new DashError('forbidden', 'Incorrect password');
  const settled = c.limiter.recordSuccess(reservation.ticket);
  if (!settled.allowed) throw new RateLimitedError(settled.retryAfterSec);
}

const CreateBody = z.object({
  name: z.string().min(1).max(256),
  password: z.string().max(1024),
  role: z.enum(['admin', 'member']),
});
const PatchBody = z
  .object({
    name: z.string().min(1).max(256).optional(),
    role: z.enum(['admin', 'member']).optional(),
    disabled: z.boolean().optional(),
    password: z.string().max(1024).optional(),
    resetTotp: z.literal(true).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to change');
const PasswordBody = z.object({ current: z.string().min(1).max(256), next: z.string().max(1024) }).strict();

const lastAdmin = (): DashError => new DashError('conflict', 'The last enabled admin cannot be removed, demoted or disabled');

/** Throws when removing `target`'s enabled-admin status would leave no enabled admin. Call inside the transaction. */
function guardLastAdmin(db: BetterSqlite3.Database, targetId: string): void {
  const others = (
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?").get(targetId) as { n: number }
  ).n;
  if (others === 0) throw lastAdmin();
}

function isConstraint(err: unknown): boolean {
  return (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

export function registerAdminRoutes(app: FastifyInstance, c: AuthRouteCtx): void {
  const { db } = c;

  app.get('/api/admin/users', (req) => {
    const user = requireUserFrom(req);
    if (user.role !== 'admin') throw new DashError('forbidden', 'Admin only');
    return (db.prepare(`SELECT ${COLUMNS} FROM users ORDER BY created_at, id`).all() as Row[]).map((r) => toDto(c, r));
  });

  app.post('/api/admin/users', async (req, reply) => {
    const actor = requireAdmin(req);
    const body = parseWith(CreateBody, req.body);
    const ip = clientIp(req);
    const deps: UserDeps = {
      ...c.userDeps,
      audit: (e) =>
        c.core.audit({ ...e, userId: actor.id, ip, detail: { ...e.detail, target: e.userId } }),
    };
    const created = await createUser(deps, body);
    const row = db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(created.id) as Row;
    return reply.status(201).send(toDto(c, row));
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const actor = requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = parseWith(PatchBody, req.body);
    const ip = clientIp(req);
    if (!findUserById(db, id)) throw new DashError('not_found', 'User not found');

    let name: string | undefined;
    let handle: string | undefined;
    if (body.name !== undefined) {
      name = body.name.trim();
      if (name === '' || name.length > 64) throw new DashError('invalid', 'Name must be 1-64 characters');
      handle = handleFor(name);
    }
    let passwordHash: string | undefined;
    if (body.password !== undefined) {
      validatePassword(body.password);
      passwordHash = await hashPassword(body.password);
    }

    let before!: Row;
    try {
      c.applyUserChange(id, () => {
        db.transaction(() => {
          const cur = db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id) as Row | undefined;
          if (!cur) throw new DashError('not_found', 'User not found');
          before = cur;
          const nextRole = body.role ?? cur.role;
          const nextDisabled = body.disabled === undefined ? cur.disabled !== 0 : body.disabled;
          if (cur.role === 'admin' && cur.disabled === 0 && !(nextRole === 'admin' && !nextDisabled)) guardLastAdmin(db, id);
          if (name !== undefined && handle !== undefined) {
            const clash = db.prepare('SELECT 1 FROM users WHERE (name = ? OR handle = ?) AND id != ?').get(name, handle, id);
            if (clash) throw new DashError('conflict', 'A user with this name already exists');
          }
          const sets: string[] = [];
          const args: unknown[] = [];
          const set = (col: string, v: unknown): void => {
            sets.push(`${col} = ?`);
            args.push(v);
          };
          if (name !== undefined) {
            set('name', name);
            set('handle', handle);
          }
          if (body.role !== undefined) set('role', body.role);
          if (body.disabled !== undefined) set('disabled', body.disabled ? 1 : 0);
          if (passwordHash !== undefined) set('password_hash', passwordHash);
          if (body.resetTotp) {
            set('totp_secret_enc', null);
            set('totp_last_step', null);
          }
          db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
          if (passwordHash !== undefined || body.disabled === true) {
            db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
          }
        }).immediate();
      });
    } catch (err) {
      if (isConstraint(err)) throw new DashError('conflict', 'A user with this name already exists');
      throw err;
    }

    if (body.role !== undefined || body.disabled !== undefined) c.appPasswords.dropUser(id);
    const audit = (action: string, detail: object): void =>
      c.core.audit({ userId: actor.id, action, detail: { target: id, ...detail }, ip });
    const fields = [name !== undefined && 'name', body.role !== undefined && 'role'].filter(Boolean);
    if (fields.length > 0) audit('user.update', { fields });
    if (body.disabled !== undefined && body.disabled !== (before.disabled !== 0)) {
      audit(body.disabled ? 'user.disable' : 'user.enable', {});
    }
    if (passwordHash !== undefined) audit('user.password.reset', {});
    if (body.resetTotp) audit('auth.totp.reset', {});
    const row = db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`).get(id) as Row;
    return toDto(c, row);
  });

  app.delete('/api/admin/users/:id', (req, reply) => {
    const actor = requireAdmin(req);
    const { id } = req.params as { id: string };
    const target = findUserById(db, id);
    if (!target) throw new DashError('not_found', 'User not found');
    c.applyUserChange(id, () => {
      // One transaction for every SQL change; the in-memory grants map is only touched after it committed.
      db.transaction(() => {
        const cur = db.prepare('SELECT role, disabled FROM users WHERE id = ?').get(id) as { role: string; disabled: number } | undefined;
        if (!cur) throw new DashError('not_found', 'User not found');
        if (cur.role === 'admin' && cur.disabled === 0) guardLastAdmin(db, id);
        db.prepare('DELETE FROM grants WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM app_passwords WHERE user_id = ?').run(id);
        db.prepare('DELETE FROM users WHERE id = ?').run(id);
      }).immediate();
      c.forgetUserGrants(id);
    });
    c.appPasswords.dropUser(id);
    c.core.audit({ userId: actor.id, action: 'user.delete', detail: { target: id, name: target.name }, ip: clientIp(req) });
    return reply.status(204).send();
  });

  app.post('/api/me/password', async (req, reply) => {
    const user = requireUserFrom(req);
    requireCsrf(req);
    const body = parseWith(PasswordBody, req.body);
    validatePassword(body.next);
    await checkOwnPassword(c, user.id, body.current);
    const passwordHash = await hashPassword(body.next);
    const sid = readSidCookie(req.headers.cookie);
    const keep = sid ? hashSid(sid) : '';
    c.applyUserChange(user.id, () => {
      db.transaction(() => {
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
        db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(user.id, keep);
      }).immediate();
    });
    c.core.audit({ userId: user.id, action: 'user.password.change', ip: clientIp(req) });
    return reply.status(204).send();
  });
}
