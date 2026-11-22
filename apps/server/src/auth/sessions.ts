import { createHash, randomBytes } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { UserId } from '@dash/contract';
import type { SessionUser } from '../seams.js';

export const COOKIE_NAME = 'dash_sid';
export const DAY_MS = 24 * 60 * 60 * 1000;
export const IDLE_MS = 30 * DAY_MS;
export const ABSOLUTE_MS = 180 * DAY_MS;
export const TOUCH_INTERVAL_MS = 60 * 1000;
export const MAX_SESSIONS_PER_USER = 20;

export interface ResolvedSession {
  user: SessionUser;
  csrf: string;
}

export function hashSid(sid: string): string {
  return createHash('sha256').update(sid).digest('hex');
}

/** Creates a session; returns the cookie value (never stored) and the csrf token. */
export function createSession(
  db: BetterSqlite3.Database,
  userId: UserId,
  now: Date,
  meta: { ua?: string | undefined; ip?: string | undefined } = {},
): { sid: string; csrf: string } {
  const sid = randomBytes(32).toString('base64url');
  const csrf = randomBytes(32).toString('base64url');
  const at = now.toISOString();
  const expires = new Date(now.getTime() + ABSOLUTE_MS).toISOString();
  db.transaction(() => {
    db.prepare(
      'INSERT INTO sessions (id_hash, user_id, csrf, created_at, last_seen_at, expires_at, ua, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(hashSid(sid), userId, csrf, at, at, expires, meta.ua?.slice(0, 256) ?? null, meta.ip ?? null);
    // Keep the newest MAX_SESSIONS_PER_USER; rowid breaks created_at ties (insertion order).
    db.prepare(
      `DELETE FROM sessions WHERE user_id = ? AND id_hash NOT IN (
         SELECT id_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    ).run(userId, userId, MAX_SESSIONS_PER_USER);
  })();
  return { sid, csrf };
}

interface Row {
  csrf: string;
  last_seen_at: string;
  expires_at: string;
  uid: string;
  name: string;
  handle: string;
  role: 'admin' | 'member';
  disabled: number;
}

/**
 * Resolves a cookie value to its user and csrf token. Expired sessions are deleted when encountered; a
 * session of a disabled user counts as absent. `last_seen_at` is written at most once a minute.
 */
export function resolveSession(db: BetterSqlite3.Database, sid: string, now: Date): ResolvedSession | null {
  const idHash = hashSid(sid);
  const row = db
    .prepare(
      `SELECT s.csrf, s.last_seen_at, s.expires_at, u.id AS uid, u.name, u.handle, u.role, u.disabled
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`,
    )
    .get(idHash) as Row | undefined;
  if (!row) return null;
  const nowMs = now.getTime();
  const lastSeen = Date.parse(row.last_seen_at);
  if (Date.parse(row.expires_at) <= nowMs || lastSeen + IDLE_MS <= nowMs) {
    deleteSession(db, idHash);
    return null;
  }
  if (row.disabled) return null;
  if (nowMs - lastSeen >= TOUCH_INTERVAL_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(now.toISOString(), idHash);
  }
  return { user: { id: row.uid, name: row.name, handle: row.handle, role: row.role }, csrf: row.csrf };
}

export function deleteSession(db: BetterSqlite3.Database, idHash: string): void {
  db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash);
}

export function deleteUserSessions(db: BetterSqlite3.Database, userId: UserId): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** For a daily job: removes sessions past their absolute or idle expiry. Returns the number removed. */
export function purgeExpiredSessions(db: BetterSqlite3.Database, now: Date): number {
  const idleCutoff = new Date(now.getTime() - IDLE_MS).toISOString();
  return db
    .prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?')
    .run(now.toISOString(), idleCutoff).changes;
}

export function sessionCookie(sid: string): string {
  return `${COOKIE_NAME}=${sid}; Max-Age=${ABSOLUTE_MS / 1000}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function clearedCookie(): string {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function readSidCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE_NAME) {
      const v = part.slice(i + 1).trim();
      return v === '' ? null : v;
    }
  }
  return null;
}
