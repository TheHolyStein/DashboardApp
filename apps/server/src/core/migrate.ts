import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { DashError, type Migration, type ModuleId } from '@dash/contract';

/** Directory holding the SQL migrations (resolves from both src/core and dist/core). */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle/', import.meta.url));

/**
 * Applies every `*.sql` file in `dir` (default `apps/server/drizzle/`) in filename order, each in
 * its own immediate transaction, recording the file name in `__dash_migrations`. Idempotent.
 * Later tracks (e.g. auth) add tables by adding a numbered SQL file; no code change is needed.
 */
export function migrateCore(db: BetterSqlite3.Database, dir: string = MIGRATIONS_DIR): void {
  db.exec(`CREATE TABLE IF NOT EXISTS __dash_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  const applied = new Set(
    (db.prepare('SELECT name FROM __dash_migrations').all() as { name: string }[]).map((r) => r.name),
  );
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const record = db.prepare('INSERT INTO __dash_migrations (name) VALUES (?)');
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(`${dir}/${file}`, 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(file);
    }).immediate();
  }
}

export function modulePrefix(moduleId: ModuleId): string {
  return `m_${moduleId.replaceAll('-', '_')}_`;
}

// An identifier as written in SQL: optionally schema-qualified, optionally quoted with "", ``, or [].
const IDENT = String.raw`(?:(?:"[^"]*"|\`[^\`]*\`|\[[^\]]*\]|\w+)\s*\.\s*)?("[^"]*"|\`[^\`]*\`|\[[^\]]*\]|\w+)`;
const IF_NOT_EXISTS = String.raw`(?:IF\s+NOT\s+EXISTS\s+)?`;
const IF_EXISTS = String.raw`(?:IF\s+EXISTS\s+)?`;

/** [pattern, group indexes that capture names that must carry the module prefix] */
const CHECKS: Array<[RegExp, number[]]> = [
  [new RegExp(String.raw`\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:VIRTUAL\s+)?TABLE\s+${IF_NOT_EXISTS}${IDENT}`, 'gi'), [1]],
  [new RegExp(String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+${IF_NOT_EXISTS}${IDENT}\s+ON\s+${IDENT}`, 'gi'), [1, 2]],
  [new RegExp(String.raw`\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\s+${IF_NOT_EXISTS}${IDENT}[^;]*?\bON\s+${IDENT}`, 'gi'), [1, 2]],
  [new RegExp(String.raw`\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?VIEW\s+${IF_NOT_EXISTS}${IDENT}`, 'gi'), [1]],
  [new RegExp(String.raw`\bALTER\s+TABLE\s+${IDENT}(?:\s+RENAME\s+TO\s+${IDENT})?`, 'gi'), [1, 2]],
  [new RegExp(String.raw`\bDROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)\s+${IF_EXISTS}${IDENT}`, 'gi'), [1]],
  [new RegExp(String.raw`\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+${IDENT}`, 'gi'), [1]],
  [new RegExp(String.raw`\bREPLACE\s+INTO\s+${IDENT}`, 'gi'), [1]],
  [new RegExp(String.raw`(?<!\bDO\s+)\bUPDATE\s+(?:OR\s+\w+\s+)?${IDENT}`, 'gi'), [1]],
  [new RegExp(String.raw`\bDELETE\s+FROM\s+${IDENT}`, 'gi'), [1]],
];
// "UPDATE OF col ON t" / "UPDATE ON t" in trigger headers are not UPDATE statements.
const NOT_A_TABLE = new Set(['on', 'of', 'set']);
const FORBIDDEN = /\b(?:ATTACH|DETACH|PRAGMA)\b/i;

function unquote(name: string): string {
  const first = name[0];
  if (first === '"' || first === '`' || first === '[') return name.slice(1, -1);
  return name;
}

/** Remove comments and string literals so keywords inside them are not matched. */
function stripNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/**
 * Checks that every table/index/trigger/view that a migration creates, alters, drops, or writes to
 * starts with the module's prefix. This is a regex scan, not a SQL parser: it decides what can be
 * decided cheaply and rejects ATTACH/DETACH/PRAGMA outright.
 *
 * Known limit: the prefix of module `news` (`m_news_`) is also a prefix of tables of module
 * `news-extra` (`m_news_extra_...`). A table named `m_news_extra_x` is indistinguishable from a
 * legitimate table `extra_x` of module `news`, so it is accepted. The reverse direction (module
 * `news-extra` touching `m_news_x`) is rejected because `m_news_x` lacks `m_news_extra_`.
 * Reads (SELECT, foreign-key REFERENCES) are not restricted.
 */
export function assertMigrationScope(moduleId: ModuleId, migration: Migration): void {
  const prefix = modulePrefix(moduleId).toLowerCase();
  const fail = (why: string): never => {
    throw new DashError('invalid', `migration ${migration.id} of module ${moduleId}: ${why}`, {
      moduleId,
      migration: migration.id,
    });
  };
  const sql = stripNoise(migration.up);
  if (FORBIDDEN.test(sql)) fail('ATTACH, DETACH and PRAGMA are not allowed');
  for (const [re, groups] of CHECKS) {
    for (const m of sql.matchAll(re)) {
      for (const g of groups) {
        const raw = m[g];
        if (raw === undefined) continue;
        const name = unquote(raw);
        if (NOT_A_TABLE.has(name.toLowerCase()) && /\bUPDATE\b/i.test(m[0])) continue;
        if (!name.toLowerCase().startsWith(prefix)) {
          fail(`"${name}" does not start with required prefix ${prefix}`);
        }
      }
    }
  }
}

/**
 * Applies the module's pending migrations (id greater than module_state.migration_id), ascending,
 * each in its own transaction together with the migration_id update. A failing migration rolls
 * back completely and leaves migration_id at the last successful id. Requires migrateCore first.
 */
export function migrateModule(
  db: BetterSqlite3.Database,
  moduleId: ModuleId,
  migrations: Migration[],
): void {
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(moduleId)) {
    throw new DashError('invalid', `invalid module id: ${moduleId}`);
  }
  const sorted = [...migrations].sort((a, b) => a.id - b.id);
  let prev = 0;
  for (const m of sorted) {
    if (!Number.isInteger(m.id) || m.id <= prev) {
      throw new DashError('invalid', `migration ids of module ${moduleId} must be unique integers >= 1`);
    }
    prev = m.id;
    assertMigrationScope(moduleId, m);
  }

  const current = db
    .prepare('SELECT migration_id AS id FROM module_state WHERE module_id = ?')
    .pluck()
    .get(moduleId) as number | undefined;
  const setId = db.prepare(
    `INSERT INTO module_state (module_id, migration_id) VALUES (?, ?)
     ON CONFLICT(module_id) DO UPDATE SET migration_id = excluded.migration_id`,
  );
  for (const m of sorted) {
    if (m.id <= (current ?? 0)) continue;
    db.transaction(() => {
      db.exec(m.up);
      setId.run(moduleId, m.id);
    }).immediate();
  }
}
