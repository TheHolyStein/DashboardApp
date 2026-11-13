import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import * as OTPAuth from 'otpauth';
import { z } from 'zod';
import { DashError, type UserId } from '@dash/contract';
import { parseWith, requireCsrf } from '../core/csrf.js';
import { checkOwnPassword, type AuthRouteCtx } from './admin.js';
import { clientIp } from './ratelimit.js';
import { requireUserFrom } from './plugin.js';

const PERIOD = 30;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface TotpDeps {
  db: BetterSqlite3.Database;
  now: () => Date;
  /** Server secret key (loaded lazily so tests without TOTP never touch the key file). */
  key: () => Buffer;
}

export interface Totp {
  /** `unreadable`: a stored value that cannot be decrypted or parsed (lost key, corruption). */
  state(userId: UserId, encrypted: string | null): 'none' | 'pending' | 'enabled' | 'unreadable';
  /** True for `enabled` and `unreadable` (fail closed: an unverifiable secret still gates sign-in). */
  isEnabled(userId: UserId, encrypted: string | null): boolean;
  /**
   * Checks a login code for an enabled user and, if right and newer than the last accepted step,
   * records the step. Returns false for a wrong or replayed code.
   */
  verifyLogin(userId: UserId, encrypted: string | null, code: string): boolean;
  /** Stores a new pending secret (replacing any pending one). */
  setup(user: { id: UserId; name: string }): { otpauthUrl: string; secret: string };
  /** Activates the pending secret if `code` matches it; false on a wrong code. */
  enable(userId: UserId, encrypted: string | null, code: string): boolean;
  disable(userId: UserId): void;
}

function derive(key: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), 'dash-totp-v1', 32));
}

function encrypt(key: Buffer, userId: string, plain: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const c = createCipheriv('aes-256-gcm', derive(key), nonce);
  c.setAAD(Buffer.from(userId, 'utf8'));
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([nonce, body, c.getAuthTag()]).toString('base64');
}

function decrypt(key: Buffer, userId: string, stored: string): string | null {
  try {
    const raw = Buffer.from(stored, 'base64');
    if (raw.length < NONCE_BYTES + TAG_BYTES) return null;
    const d = createDecipheriv('aes-256-gcm', derive(key), raw.subarray(0, NONCE_BYTES));
    d.setAAD(Buffer.from(userId, 'utf8'));
    d.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([d.update(raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function makeTotp(label: string, base32: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: 'Dashboard',
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD,
    secret: OTPAuth.Secret.fromBase32(base32),
  });
}

/** Matching time step of `code` within +-1 step, or null. */
function matchStep(base32: string, code: string, at: Date): number | null {
  const norm = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(norm)) return null;
  const delta = makeTotp('x', base32).validate({ token: norm, timestamp: at.getTime(), window: 1 });
  if (delta === null) return null;
  return Math.floor(at.getTime() / 1000 / PERIOD) + delta;
}

export function createTotp(deps: TotpDeps): Totp {
  const { db } = deps;
  const open = (userId: string, enc: string | null): { state: 'pending' | 'active'; secret: string } | null => {
    if (!enc) return null;
    const plain = decrypt(deps.key(), userId, enc);
    if (plain === null) return null;
    if (plain.startsWith('active:')) return { state: 'active', secret: plain.slice('active:'.length) };
    if (plain.startsWith('pending:')) return { state: 'pending', secret: plain.slice('pending:'.length) };
    return null;
  };
  const acceptStep = db.prepare(
    'UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)',
  );
  return {
    state(userId, enc) {
      if (enc === null || enc === '') return 'none';
      const s = open(userId, enc);
      if (!s) return 'unreadable';
      return s.state === 'active' ? 'enabled' : 'pending';
    },
    isEnabled(userId, enc) {
      const st = this.state(userId, enc);
      return st === 'enabled' || st === 'unreadable';
    },
    verifyLogin(userId, enc, code) {
      const s = open(userId, enc);
      if (s?.state !== 'active') return false;
      const step = matchStep(s.secret, code, deps.now());
      if (step === null) return false;
      return acceptStep.run(step, userId, step).changes === 1;
    },
    setup(user) {
      const secret = new OTPAuth.Secret({ size: 20 }).base32;
      db.prepare('UPDATE users SET totp_secret_enc = ?, totp_last_step = NULL WHERE id = ?').run(
        encrypt(deps.key(), user.id, `pending:${secret}`),
        user.id,
      );
      return { otpauthUrl: makeTotp(user.name, secret).toString(), secret };
    },
    enable(userId, enc, code) {
      const s = open(userId, enc);
      if (s?.state !== 'pending') throw new DashError('conflict', 'No TOTP setup in progress');
      const step = matchStep(s.secret, code, deps.now());
      if (step === null) return false;
      db.prepare('UPDATE users SET totp_secret_enc = ?, totp_last_step = ? WHERE id = ?').run(
        encrypt(deps.key(), userId, `active:${s.secret}`),
        step,
        userId,
      );
      return true;
    },
    disable(userId) {
      db.prepare('UPDATE users SET totp_secret_enc = NULL, totp_last_step = NULL WHERE id = ?').run(userId);
    },
  };
}

const CodeBody = z.object({ code: z.string().min(1).max(16) }).strict();
const PasswordBody = z.object({ password: z.string().min(1).max(256) }).strict();

export function registerTotpRoutes(app: FastifyInstance, c: AuthRouteCtx): void {
  const enc = (id: UserId): string | null =>
    (c.db.prepare('SELECT totp_secret_enc AS e FROM users WHERE id = ?').get(id) as { e: string | null } | undefined)?.e ?? null;

  app.post('/api/me/totp/setup', (req) => {
    const user = requireUserFrom(req);
    requireCsrf(req);
    if (c.totp.isEnabled(user.id, enc(user.id))) {
      throw new DashError('conflict', 'TOTP is already enabled; disable it first');
    }
    return c.totp.setup(user);
  });
  app.post('/api/me/totp/enable', (req, reply) => {
    const user = requireUserFrom(req);
    requireCsrf(req);
    const { code } = parseWith(CodeBody, req.body);
    if (!c.totp.enable(user.id, enc(user.id), code)) throw new DashError('invalid', 'Invalid code');
    c.core.audit({ userId: user.id, action: 'auth.totp.enable', ip: clientIp(req) });
    return reply.status(204).send();
  });
  app.post('/api/me/totp/disable', async (req, reply) => {
    const user = requireUserFrom(req);
    requireCsrf(req);
    const { password } = parseWith(PasswordBody, req.body);
    await checkOwnPassword(c, user.id, password);
    c.totp.disable(user.id);
    c.core.audit({ userId: user.id, action: 'auth.totp.disable', ip: clientIp(req) });
    return reply.status(204).send();
  });
}
