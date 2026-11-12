import BetterSqlite3 from 'better-sqlite3';

export function openDb(file: string): BetterSqlite3.Database {
  const db = new BetterSqlite3(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** Online backup via the SQLite backup API; safe while the database is in use. */
export async function backupTo(db: BetterSqlite3.Database, destFile: string): Promise<void> {
  await db.backup(destFile);
}
