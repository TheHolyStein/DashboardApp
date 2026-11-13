import type BetterSqlite3 from 'better-sqlite3';
import type { CoreSeam } from '../seams.js';

/** `CoreSeam.audit` over the `audit_log` table. */
export function createAudit(db: BetterSqlite3.Database, now: () => Date): CoreSeam['audit'] {
  const insert = db.prepare('INSERT INTO audit_log (at, user_id, action, detail, ip) VALUES (?, ?, ?, ?, ?)');
  return (entry) => {
    insert.run(
      now().toISOString(),
      entry.userId,
      entry.action,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
      entry.ip ?? null,
    );
  };
}
