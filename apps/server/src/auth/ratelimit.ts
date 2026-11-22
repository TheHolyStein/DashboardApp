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

export interface Row {
  count: number;
  window_start: string;
  locked_until: string | null;
  lock_level: number;
  last_failure_at: string | null;
}

/** Proof of one reserved attempt; pass it to `recordSuccess` when the password turned out right. */
export interface AttemptTicket {
  readonly keys: ReadonlyArray<{ key: string; prev: Row | undefined; lockedByMe: boolean }>;
}

export type Reservation = { allowed: true; ticket: AttemptTicket } | { allowed: false; retryAfterSec: number };

export interface LoginLimiterDeps {
  db: BetterSqlite3.Database;
  now: () => Date;
  /** Called when an attempt locks a key (used for the `auth.lockout` audit entry). */
  onLock?(lock: { key: string; kind: 'ip' | 'user'; lockSec: number }): void;
}

export interface LoginLimiter {
  /** Read-only: refuses when any key is locked. The login path does not use it (it would race with verification). */
  check(keys: string[]): LimitCheck;
  /**
   * Atomic (one SQLite transaction), run BEFORE password verification: refuses if any key is locked
   * (nothing counted), else counts this attempt on every key as if it had failed, locking a key on
   * its 5th counted attempt. A wrong password needs nothing more.
   */
  reserve(keys: string[]): Reservation;
  /** Counts a failure without a reservation (for other callers). */
  recordFailure(keys: string[]): void;
  /**
   * Settles a reservation whose password was right. If a key was locked by another request in the
   * meantime, refuses and changes nothing. Otherwise clears the `user:` key and undoes this one
   * reservation on the other keys (decrement, or restore the row if this very reservation locked it).
   */
  recordSuccess(ticket: AttemptTicket): LimitCheck;
  /**
   * Refunds a reservation as if it had not happened (the password was right but the request is not
   * a finished attempt, e.g. "TOTP code required"). Never unlocks a key locked by another request.
   */
  release(ticket: AttemptTicket): void;
  /** Deletes rows that are unlocked and whose lock level has fully decayed. Needs scheduling. */
  purge(now: Date): void;
}

export const ipKey = (ip: string): string => `ip:${ip}`;
export const userKey = (name: string): string => `user:${name.trim().toLowerCase().slice(0, MAX_NAME_LENGTH)}`;

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

  const write = (key: string, row: Row | undefined): void => {
    if (!row) {
      remove.run(key);
      return;
    }
    upsert.run({
      key,
      count: row.count,
      windowStart: row.window_start,
      lockedUntil: row.locked_until,
      lockLevel: row.lock_level,
      lastFailureAt: row.last_failure_at,
    });
  };

  const check = (keys: string[]): LimitCheck => {
    const t = deps.now().getTime();
    let retryMs = 0;
    for (const key of keys) {
      const row = select.get(key) as Row | undefined;
      if (row?.locked_until) retryMs = Math.max(retryMs, Date.parse(row.locked_until) - t);
    }
    return retryMs > 0 ? { allowed: false, retryAfterSec: Math.ceil(retryMs / 1000) } : { allowed: true };
  };

  /** Counts one attempt on each unlocked key. Must run inside a transaction. */
  const count = (keys: string[]): AttemptTicket['keys'] => {
    const nowDate = deps.now();
    const t = nowDate.getTime();
    const iso = nowDate.toISOString();
    const out: Array<{ key: string; prev: Row | undefined; lockedByMe: boolean }> = [];
    for (const key of new Set(keys)) {
      const row = select.get(key) as Row | undefined;
      if (row?.locked_until && Date.parse(row.locked_until) > t) continue; // locked: not a further failure
      const decayed = !row?.last_failure_at || t - Date.parse(row.last_failure_at) >= LEVEL_DECAY_MS;
      let level = decayed ? 0 : (row?.lock_level ?? 0);
      const windowOpen = row !== undefined && !row.locked_until && t - Date.parse(row.window_start) < WINDOW_MS;
      let n = windowOpen ? row.count + 1 : 1;
      let windowStart = windowOpen ? row.window_start : iso;
      let lockedUntil: string | null = null;
      if (n >= MAX_FAILURES) {
        const lockMs = Math.min(BASE_LOCK_MS * 2 ** level, MAX_LOCK_MS);
        lockedUntil = new Date(t + lockMs).toISOString();
        level += 1;
        n = 0;
        windowStart = iso;
        deps.onLock?.({ key, kind: key.startsWith('ip:') ? 'ip' : 'user', lockSec: lockMs / 1000 });
      }
      write(key, {
        count: n,
        window_start: windowStart,
        locked_until: lockedUntil,
        lock_level: level,
        last_failure_at: iso,
      });
      out.push({ key, prev: row, lockedByMe: lockedUntil !== null });
    }
    return out;
  };

  const reserveTx = db.transaction((keys: string[]): Reservation => {
    const verdict = check(keys);
    if (!verdict.allowed) return verdict;
    return { allowed: true, ticket: { keys: count(keys) } };
  });

  const failureTx = db.transaction((keys: string[]): void => {
    count(keys);
  });

  const successTx = db.transaction((ticket: AttemptTicket): LimitCheck => {
    const t = deps.now().getTime();
    const state = ticket.keys.map((k) => {
      const row = select.get(k.key) as Row | undefined;
      const locked = row?.locked_until ? Date.parse(row.locked_until) > t : false;
      return { ...k, row, locked };
    });
    // Locked by another request in the meantime (not by this attempt's own reservation).
    const blocked = state.filter((k) => k.locked && !k.lockedByMe);
    if (blocked.length > 0) {
      const retryMs = Math.max(...blocked.map((k) => Date.parse(k.row?.locked_until ?? '') - t));
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryMs / 1000)) };
    }
    for (const k of state) {
      if (k.key.startsWith('user:')) remove.run(k.key);
      else if (k.lockedByMe) write(k.key, k.prev); // no other request could touch it while locked
      else if (k.row && k.row.count > 0) write(k.key, { ...k.row, count: k.row.count - 1 });
    }
    return { allowed: true };
  });

  const releaseTx = db.transaction((ticket: AttemptTicket): void => {
    const t = deps.now().getTime();
    for (const k of ticket.keys) {
      const row = select.get(k.key) as Row | undefined;
      if (!row) continue;
      const locked = row.locked_until ? Date.parse(row.locked_until) > t : false;
      if (locked) {
        if (k.lockedByMe) write(k.key, k.prev); // this very reservation caused the lock; undo it
        continue;
      }
      if (row.count > 0) {
        if (row.count === 1 && !k.prev) write(k.key, undefined);
        else write(k.key, { ...row, count: row.count - 1 });
      }
    }
  });

  return {
    check,
    release: (ticket) => releaseTx.immediate(ticket),
    reserve: (keys) => reserveTx.immediate(keys),
    recordFailure: (keys) => failureTx.immediate(keys),
    recordSuccess: (ticket) => successTx.immediate(ticket),
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
