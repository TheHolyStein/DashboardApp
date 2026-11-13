import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';

export interface CacheRow {
  key: string;
  status: number;
  headers: string;
  body: Buffer | null;
  expires_at: string;
  etag: string | null;
}

const KEY_HEADERS = ['accept', 'accept-language', 'authorization'];

export function cacheKey(moduleId: string, method: string, url: string, headers: Record<string, string>): string {
  const picked = KEY_HEADERS.map((h) => [h, headers[h] ?? '']);
  return createHash('sha256').update(JSON.stringify([moduleId, method, url, picked])).digest('hex');
}

export function readCache(db: BetterSqlite3.Database, key: string): CacheRow | undefined {
  return db.prepare('SELECT key, status, headers, body, expires_at, etag FROM http_cache WHERE key = ?').get(key) as
    | CacheRow
    | undefined;
}

export function writeCache(
  db: BetterSqlite3.Database,
  row: { key: string; status: number; headers: Record<string, string>; body: Buffer; expiresAt: string; etag: string | null },
): void {
  db.prepare(
    `INSERT INTO http_cache (key, status, headers, body, expires_at, etag) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET status = excluded.status, headers = excluded.headers, body = excluded.body,
       expires_at = excluded.expires_at, etag = excluded.etag`,
  ).run(row.key, row.status, JSON.stringify(row.headers), row.body, row.expiresAt, row.etag);
}

export function refreshCache(db: BetterSqlite3.Database, key: string, expiresAt: string): void {
  db.prepare('UPDATE http_cache SET expires_at = ? WHERE key = ?').run(expiresAt, key);
}

/** Deletes rows more than 24 h past their expiry. Scheduled daily by a later task. */
export function purgeExpiredCache(db: BetterSqlite3.Database, now: Date): number {
  const cutoff = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  return db.prepare('DELETE FROM http_cache WHERE expires_at < ?').run(cutoff).changes;
}
