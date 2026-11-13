import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hash, hashSync, verifySync } from '@node-rs/argon2';
import type BetterSqlite3 from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DashError, type UserId } from '@dash/contract';
import { parseWith, requireCsrf } from '../core/csrf.js';
import { uuidv7 } from '../core/ids.js';
import type { SessionUser } from '../seams.js';
import type { AuthRouteCtx } from './admin.js';
import { requireUserFrom } from './plugin.js';
import { clientIp, type LoginLimiter } from './ratelimit.js';
import { ARGON2_PARAMS } from './users.js';

export const MAX_APP_PASSWORDS = 10;
const CACHE_MS = 10 * 60_000;
const TOUCH_MS = 60_000;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const LENGTH = 24;

/** 24 base32 characters from 15 random bytes (120 bits). */
function generate(): string {
  const bytes = randomBytes(15);
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

const display = (p: string): string => p.match(/.{4}/g)?.join('-') ?? p;

/** Upper-case, separators removed; null when not a well-formed password. */
export function normalizeAppPassword(input: string): string | null {
  const n = input.toUpperCase().replace(/[\s-]/g, '');
  return n.length === LENGTH && /^[A-Z2-7]+$/.test(n) ? n : null;
}

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

export interface AppPasswordsDeps {
  db: BetterSqlite3.Database;
  now: () => Date;
  limiter: LoginLimiter;
  /** Synchronous argon2 check (tests inject a counter). */
  verifyHash?: ((hashed: string, password: string) => boolean) | undefined;
}

export interface AppPasswords {
  /** Computes the dummy hash; await during plugin registration. */
  init(): Promise<void>;
  verify(basicAuthHeader: string | undefined): SessionUser | null;
  create(userId: UserId, label: string): Promise<{ id: string; label: string; password: string }>;
  /** Deletes an app password of that user; false when it does not exist. */
  remove(userId: UserId, id: string): boolean;
  /** Drops cached verifications of a user (disabled, deleted, role changed). */
  dropUser(userId: UserId): void;
}

interface Cached {
  userId: UserId;
  digest: Buffer;
  expires: number;
}

export function createAppPasswords(deps: AppPasswordsDeps): AppPasswords {
  const { db, now, limiter } = deps;
  const verifyHash =
    deps.verifyHash ??
    ((h: string, p: string): boolean => {
      try {
        return verifySync(h, p);
      } catch {
        return false;
      }
    });
  const cache = new Map<string, Cached>();
  let dummy = '';
  const failKey = (name: string): string => `app:${name.trim().toLowerCase().slice(0, 64)}`;

  const selectUser = db.prepare('SELECT id, name, handle, role FROM users WHERE name = ? AND disabled = 0');
  const selectRow = db.prepare(
    "SELECT id, hash, last_used_at FROM app_passwords WHERE user_id = ? AND selector = ? AND scope = 'caldav'",
  );

  return {
    async init() {
      dummy = await hash('dummy-app-password-for-timing', ARGON2_PARAMS);
    },
    verify(header) {
      if (!header?.startsWith('Basic ')) return null;
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon <= 0) return null;
      const name = decoded.slice(0, colon);
      const key = failKey(name);
      if (!limiter.check([key]).allowed) return null;
      const fail = (): null => {
        limiter.recordFailure([key]);
        return null;
      };
      const password = normalizeAppPassword(decoded.slice(colon + 1));
      if (!password) return fail();
      const user = selectUser.get(name.trim()) as SessionUser | undefined;
      const row = user
        ? (selectRow.get(user.id, password.slice(0, 8)) as { id: string; hash: string; last_used_at: string | null } | undefined)
        : undefined;
      if (!user || !row) {
        verifyHash(dummy || (dummy = hashSync('dummy-app-password-for-timing', ARGON2_PARAMS)), password);
        return fail();
      }
      const t = now().getTime();
      const digest = sha(password);
      const hit = cache.get(row.id);
      let ok = false;
      if (hit && hit.expires > t && hit.userId === user.id) {
        ok = hit.digest.length === digest.length && timingSafeEqual(hit.digest, digest);
      }
      if (!ok) {
        ok = verifyHash(row.hash, password);
        if (ok) cache.set(row.id, { userId: user.id, digest, expires: t + CACHE_MS });
        else cache.delete(row.id);
      }
      if (!ok) return fail();
      if (!row.last_used_at || t - Date.parse(row.last_used_at) >= TOUCH_MS) {
        db.prepare('UPDATE app_passwords SET last_used_at = ? WHERE id = ?').run(now().toISOString(), row.id);
      }
      return { id: user.id, name: user.name, handle: user.handle, role: user.role };
    },
    async create(userId, label) {
      const count = (db.prepare('SELECT COUNT(*) AS n FROM app_passwords WHERE user_id = ?').get(userId) as { n: number }).n;
      if (count >= MAX_APP_PASSWORDS) throw new DashError('conflict', `At most ${MAX_APP_PASSWORDS} app passwords per user`);
      const password = generate();
      const hashed = await hash(password, ARGON2_PARAMS);
      const id = uuidv7(now());
      // Re-check the limit atomically with the insert (the hash above was awaited).
      db.transaction(() => {
        const n = (db.prepare('SELECT COUNT(*) AS n FROM app_passwords WHERE user_id = ?').get(userId) as { n: number }).n;
        if (n >= MAX_APP_PASSWORDS) throw new DashError('conflict', `At most ${MAX_APP_PASSWORDS} app passwords per user`);
        db.prepare(
          "INSERT INTO app_passwords (id, user_id, label, hash, selector, scope, created_at) VALUES (?, ?, ?, ?, ?, 'caldav', ?)",
        ).run(id, userId, label, hashed, password.slice(0, 8), now().toISOString());
      }).immediate();
      return { id, label, password: display(password) };
    },
    remove(userId, id) {
      const res = db.prepare('DELETE FROM app_passwords WHERE id = ? AND user_id = ?').run(id, userId);
      cache.delete(id);
      return res.changes > 0;
    },
    dropUser(userId) {
      for (const [id, c] of cache) if (c.userId === userId) cache.delete(id);
    },
  };
}

const CreateBody = z.object({ label: z.string().trim().min(1).max(60) }).strict();

export function registerAppPasswordRoutes(app: FastifyInstance, c: AuthRouteCtx): void {
  app.get('/api/me/app-passwords', (req) => {
    const user = requireUserFrom(req);
    const rows = c.db
      .prepare('SELECT id, label, scope, created_at, last_used_at FROM app_passwords WHERE user_id = ? ORDER BY created_at, id')
      .all(user.id) as Array<{ id: string; label: string; scope: string; created_at: string; last_used_at: string | null }>;
    return rows.map((r) => ({ id: r.id, label: r.label, scope: r.scope, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  });
  app.post('/api/me/app-passwords', async (req, reply) => {
    const user = requireUserFrom(req);
    requireCsrf(req);
    const { label } = parseWith(CreateBody, req.body);
    const created = await c.appPasswords.create(user.id, label);
    c.core.audit({ userId: user.id, action: 'auth.app_password.create', detail: { id: created.id, label }, ip: clientIp(req) });
    return reply.status(201).send(created);
  });
  app.delete('/api/me/app-passwords/:id', (req, reply) => {
    const user = requireUserFrom(req);
    requireCsrf(req);
    const { id } = req.params as { id: string };
    const row = c.db.prepare('SELECT label FROM app_passwords WHERE id = ? AND user_id = ?').get(id, user.id) as { label: string } | undefined;
    if (!row || !c.appPasswords.remove(user.id, id)) throw new DashError('not_found', 'App password not found');
    c.core.audit({ userId: user.id, action: 'auth.app_password.delete', detail: { id, label: row.label }, ip: clientIp(req) });
    return reply.status(204).send();
  });
}
