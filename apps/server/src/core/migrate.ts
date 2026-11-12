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

interface Token {
  kind: 'word' | 'name' | 'str' | 'punct'; // name = "x", `x`, [x]; str = 'x'; word = bare word
  value: string; // unquoted for name/str
}

/**
 * One left-to-right pass: comments are dropped, string literals and quoted identifiers become single
 * tokens, so comment markers inside literals (and keywords inside literals/comments) cannot hide or
 * fake statements. Unterminated strings/comments throw (fail closed).
 */
function tokenize(sql: string, fail: (why: string) => never): Token[] {
  const out: Token[] = [];
  let i = 0;
  const quoted = (open: string, close: string, kind: Token['kind']): void => {
    let j = i + 1;
    let value = '';
    for (;;) {
      if (j >= sql.length) fail(`unterminated ${open}…${close} token`);
      if (sql[j] === close) {
        if (open === close && sql[j + 1] === close) {
          value += close; // doubled quote is an escaped quote
          j += 2;
          continue;
        }
        break;
      }
      value += sql[j];
      j++;
    }
    out.push({ kind, value });
    i = j + 1;
  };
  while (i < sql.length) {
    const c = sql[i] as string;
    if (/\s/.test(c)) i++;
    else if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) fail('unterminated comment');
      i = end + 2;
    } else if (c === "'") quoted("'", "'", 'str');
    else if (c === '"') quoted('"', '"', 'name');
    else if (c === '`') quoted('`', '`', 'name');
    else if (c === '[') quoted('[', ']', 'name');
    else {
      const m = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i));
      if (m) {
        out.push({ kind: 'word', value: m[0] });
        i += m[0].length;
      } else {
        out.push({ kind: 'punct', value: c });
        i++;
      }
    }
  }
  return out;
}

const isWord = (t: Token | undefined, ...words: string[]): boolean =>
  t?.kind === 'word' && words.includes(t.value.toUpperCase());

/**
 * Checks that every table/index/trigger/view that a migration creates, alters, drops, or writes to
 * starts with the module's prefix. This is a token scan, not a SQL parser: it decides what can be
 * decided cheaply and fails closed, i.e. a statement keyword (CREATE, ALTER, DROP, INSERT, REPLACE
 * INTO, UPDATE, DELETE) that is not followed by a name the scanner can read is rejected. Names may
 * be bare, "double", `backtick`, [bracket] or 'single' quoted; a schema qualifier other than `main`
 * is rejected. ATTACH, DETACH and PRAGMA are rejected outright.
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
  const toks = tokenize(migration.up, fail);

  /** Reads `[schema .] name` at index i, checks the prefix, returns the index after it. */
  const name = (i: number, what: string): number => {
    let t = toks[i];
    if (t === undefined || t.kind === 'punct') return fail(`${what} is not followed by a table name`);
    if (isWord(t, 'IF', 'NOT', 'EXISTS', 'ON', 'SET', 'FROM', 'INTO', 'TO', 'OF')) {
      return fail(`${what} is not followed by a table name`);
    }
    const dot = toks[i + 1];
    if (dot?.kind === 'punct' && dot.value === '.') {
      if (t.value.toLowerCase() !== 'main') return fail(`schema "${t.value}" is not allowed`);
      i += 2;
      t = toks[i];
      if (t === undefined || t.kind === 'punct') return fail(`${what} is not followed by a table name`);
    }
    if (!t.value.toLowerCase().startsWith(prefix)) {
      return fail(`"${t.value}" does not start with required prefix ${prefix}`);
    }
    return i + 1;
  };
  const skipIf = (i: number, ...seq: string[]): number =>
    seq.every((w, k) => isWord(toks[i + k], w)) ? i + seq.length : i;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i] as Token;
    if (t.kind !== 'word') continue;
    const prev = toks[i - 1];
    switch (t.value.toUpperCase()) {
      case 'ATTACH':
      case 'DETACH':
      case 'PRAGMA':
        fail('ATTACH, DETACH and PRAGMA are not allowed');
        break;
      case 'CREATE': {
        let j = i + 1;
        while (isWord(toks[j], 'TEMP', 'TEMPORARY', 'UNIQUE', 'VIRTUAL')) j++;
        const kind = toks[j];
        if (!isWord(kind, 'TABLE', 'INDEX', 'TRIGGER', 'VIEW')) {
          fail('CREATE is not followed by TABLE, INDEX, TRIGGER or VIEW');
          break;
        }
        j = name(skipIf(j + 1, 'IF', 'NOT', 'EXISTS'), 'CREATE');
        if (isWord(kind, 'INDEX')) {
          if (!isWord(toks[j], 'ON')) fail('CREATE INDEX without ON');
          name(j + 1, 'CREATE INDEX ... ON');
        } else if (isWord(kind, 'TRIGGER')) {
          while (j < toks.length && !isWord(toks[j], 'ON')) j++;
          if (j >= toks.length) fail('CREATE TRIGGER without ON');
          name(j + 1, 'CREATE TRIGGER ... ON');
        }
        break;
      }
      case 'ALTER': {
        if (!isWord(toks[i + 1], 'TABLE')) {
          fail('ALTER is not followed by TABLE');
          break;
        }
        const j = name(i + 2, 'ALTER TABLE');
        if (isWord(toks[j], 'RENAME') && isWord(toks[j + 1], 'TO')) name(j + 2, 'RENAME TO');
        break;
      }
      case 'DROP': {
        if (!isWord(toks[i + 1], 'TABLE', 'INDEX', 'TRIGGER', 'VIEW')) {
          fail('DROP is not followed by TABLE, INDEX, TRIGGER or VIEW');
          break;
        }
        name(skipIf(i + 2, 'IF', 'EXISTS'), 'DROP');
        break;
      }
      case 'INSERT': // "AFTER INSERT ON t" in a trigger header is not a statement
        if (isWord(toks[i + 1], 'ON')) break;
        {
          let j = i + 1;
          if (isWord(toks[j], 'OR')) j += 2;
          if (!isWord(toks[j], 'INTO')) {
            fail('INSERT is not followed by INTO');
            break;
          }
          name(j + 1, 'INSERT INTO');
        }
        break;
      case 'REPLACE': // replace(...) is a function; REPLACE INTO is a statement
        if (isWord(toks[i + 1], 'INTO')) name(i + 2, 'REPLACE INTO');
        break;
      case 'UPDATE': // not a statement after DO (upsert) or in a trigger header ("UPDATE [OF cols] ON t")
        if (isWord(prev, 'DO') || isWord(toks[i + 1], 'ON', 'OF')) break;
        {
          let j = i + 1;
          if (isWord(toks[j], 'OR')) j += 2;
          name(j, 'UPDATE');
        }
        break;
      case 'DELETE':
        if (isWord(toks[i + 1], 'ON')) break; // trigger header
        if (!isWord(toks[i + 1], 'FROM')) {
          fail('DELETE is not followed by FROM');
          break;
        }
        name(i + 2, 'DELETE FROM');
        break;
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
