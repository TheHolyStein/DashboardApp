import { isIP } from 'node:net';
import type BetterSqlite3 from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';
import { DashError } from '@dash/contract';

const MINUTE = 60_000;
const WINDOW_MS = 15 * MINUTE;
const BASE_LOCK_MS = 15 * MINUTE;
const MAX_LOCK_MS = 24 * 60 * MINUTE;
const LEVEL_DECAY_MS = 24 * 60 * MINUTE;
const MAX_FAILURES = 5;
const MAX_NAME_LENGTH = 64;

/** 429 `rate_limited`; the plugin turns `retryAfterSec` into the `Retry-After` header. */
export class RateLimitedError extends DashError {
  constructor(public readonly retryAfterSec: number) {
    // The message deliberately does not say which key (ip or user) is locked.
    super('rate_limited', 'Too many sign-in attempts. Try again later.');
    this.name = 'RateLimitedError';
  }
}

export type LimitCheck = { allowed: true } | { allowed: false; retryAfterSec: number };

export interface LoginLimiterDeps {
  db: BetterSqlite3.Database;
  now: () => Date;
  /** Called when a failure locks a key (used for the `auth.lockout` audit entry). */
  onLock?(lock: { key: string; kind: 'ip' | 'user'; lockSec: number }): void;
}

export interface LoginLimiter {
  /** Refuses when any key is locked. Pure read; does not count the attempt. */
  check(keys: string[]): LimitCheck;
  recordFailure(keys: string[]): void;
  /** Clears the user key only (the ip key is left to expire). */
  recordSuccess(userKey: string): void;
  /** Deletes rows that are unlocked and whose lock level has fully decayed. Needs scheduling. */
  purge(now: Date): void;
}

export const ipKey = (ip: string): string => `ip:${ip}`;
export const userKey = (name: string): string => `user:${name.trim().toLowerCase().slice(0, MAX_NAME_LENGTH)}`;

interface Row {
  count: number;
  window_start: string;
  locked_until: string | null;
  lock_level: number;
  last_failure_at: string | null;
}

export function createLoginLimiter(deps: LoginLimiterDeps): LoginLimiter {
  const { db } = deps;
  const select = db.prepare(
    'SELECT count, window_start, locked_until, lock_level, last_failure_at FROM login_attempts WHERE key = ?',
  );
  const upsert = db.prepare(
    `INSERT INTO login_attempts (key, count, window_start, locked_until, lock_level, last_failure_at)
     VALUES (@key, @count, @windowStart, @lockedUntil, @lockLevel, @lastFailureAt)
     ON CONFLICT(key) DO UPDATE SET count = excluded.count, window_start = excluded.window_start,
       locked_until = excluded.locked_until, lock_level = excluded.lock_level,
       last_failure_at = excluded.last_failure_at`,
  );
  const remove = db.prepare('DELETE FROM login_attempts WHERE key = ?');
  const purgeStmt = db.prepare(
    'DELETE FROM login_attempts WHERE (locked_until IS NULL OR locked_until <= @now) AND (last_failure_at IS NULL OR last_failure_at <= @decayed)',
  );

  return {
    check(keys) {
      const t = deps.now().getTime();
      let retryMs = 0;
      for (const key of keys) {
        const row = select.get(key) as Row | undefined;
        if (row?.locked_until) retryMs = Math.max(retryMs, Date.parse(row.locked_until) - t);
      }
      return retryMs > 0 ? { allowed: false, retryAfterSec: Math.ceil(retryMs / 1000) } : { allowed: true };
    },

    recordFailure(keys) {
      const nowDate = deps.now();
      const t = nowDate.getTime();
      const iso = nowDate.toISOString();
      for (const key of new Set(keys)) {
        const row = select.get(key) as Row | undefined;
        if (row?.locked_until && Date.parse(row.locked_until) > t) continue; // locked: not a further failure
        const decayed = !row?.last_failure_at || t - Date.parse(row.last_failure_at) >= LEVEL_DECAY_MS;
        let level = decayed ? 0 : (row?.lock_level ?? 0);
        const windowOpen = row !== undefined && !row.locked_until && t - Date.parse(row.window_start) < WINDOW_MS;
        let count = windowOpen ? row.count + 1 : 1;
        let windowStart = windowOpen ? row.window_start : iso;
        let lockedUntil: string | null = null;
        if (count >= MAX_FAILURES) {
          const lockMs = Math.min(BASE_LOCK_MS * 2 ** level, MAX_LOCK_MS);
          lockedUntil = new Date(t + lockMs).toISOString();
          level += 1;
          count = 0;
          windowStart = iso;
          deps.onLock?.({ key, kind: key.startsWith('ip:') ? 'ip' : 'user', lockSec: lockMs / 1000 });
        }
        upsert.run({ key, count, windowStart, lockedUntil, lockLevel: level, lastFailureAt: iso });
      }
    },

    recordSuccess(key) {
      remove.run(key);
    },

    purge(now) {
      purgeStmt.run({ now: now.toISOString(), decayed: new Date(now.getTime() - LEVEL_DECAY_MS).toISOString() });
    },
  };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Client address for rate limiting and audit. The socket peer, except behind the local reverse proxy
 * (loopback peer): then the LAST X-Forwarded-For entry (Caddy appends the real client last; earlier
 * entries are client-controlled) if it is a valid IP. X-Forwarded-For from other peers is ignored.
 */
export function clientIp(request: Pick<FastifyRequest, 'socket' | 'headers'>): string {
  const peer = request.socket.remoteAddress ?? 'unknown';
  if (!LOOPBACK.has(peer)) return peer;
  const header = request.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : header;
  const last = raw?.split(',').at(-1)?.trim();
  return last && isIP(last) !== 0 ? last : peer;
}
