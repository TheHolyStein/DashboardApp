import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DashError } from '@dash/contract';
import { backupTo, openDb } from '../../src/core/db.ts';
import { migrateCore, migrateModule } from '../../src/core/migrate.ts';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'dash-a1-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function memDb() {
  const db = openDb(':memory:');
  migrateCore(db);
  return db;
}
function migrationId(db: ReturnType<typeof memDb>, id: string): number {
  const row = db.prepare('SELECT migration_id AS m FROM module_state WHERE module_id = ?').get(id) as
    | { m: number }
    | undefined;
  return row?.m ?? 0;
}
function tables(db: ReturnType<typeof memDb>): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
    (r) => r.name,
  );
}

describe('openDb', () => {
  it('sets pragmas', () => {
    const file = path.join(tmp(), 'a.db');
    const db = openDb(file);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    db.close();
  });
});

describe('migrateCore', () => {
  it('migrateCore twice is a no-op', () => {
    const db = openDb(':memory:');
    migrateCore(db);
    const before = tables(db).sort();
    const applied = db.prepare('SELECT count(*) AS c FROM __dash_migrations').get() as { c: number };
    expect(() => migrateCore(db)).not.toThrow();
    expect(tables(db).sort()).toEqual(before);
    expect(db.prepare('SELECT count(*) AS c FROM __dash_migrations').get()).toEqual(applied);
    for (const t of [
      'audit_log', 'pages', 'instances', 'snapshots', 'kv', 'secrets',
      'module_state', 'job_state', 'notifications', 'http_cache',
    ]) {
      expect(before).toContain(t);
    }
  });

  it('snapshots are unique per module and instance, including NULL instance', () => {
    const db = memDb();
    const ins = db.prepare("INSERT INTO snapshots (module_id, instance_id, data, updated_at) VALUES (?, ?, '{}', 'x')");
    ins.run('weather', null);
    expect(() => ins.run('weather', null)).toThrow();
    ins.run('weather', 'i1');
    expect(() => ins.run('weather', 'i1')).toThrow();
  });
});

describe('migrateModule', () => {
  it('migrateModule applies only new ids, in order', () => {
    const db = memDb();
    const m1 = { id: 1, up: 'CREATE TABLE m_news_a (x INTEGER);' };
    const m2 = { id: 2, up: 'CREATE TABLE m_news_b (y INTEGER); INSERT INTO m_news_a VALUES (1);' };
    migrateModule(db, 'news', [m2, m1]); // unsorted input is applied ascending
    expect(migrationId(db, 'news')).toBe(2);
    expect(db.prepare('SELECT x FROM m_news_a').all()).toEqual([{ x: 1 }]);
    const m3 = { id: 3, up: 'INSERT INTO m_news_a VALUES (2);' };
    migrateModule(db, 'news', [m1, m2, m3]); // m1, m2 not re-run (would fail: table exists)
    expect(migrationId(db, 'news')).toBe(3);
    expect(db.prepare('SELECT count(*) AS c FROM m_news_a').get()).toEqual({ c: 2 });
  });

  it("migrateModule rejects 'CREATE TABLE users2' with DashError('invalid')", () => {
    const db = memDb();
    const run = () => migrateModule(db, 'news', [{ id: 1, up: 'CREATE TABLE users2 (id TEXT)' }]);
    expect(run).toThrow(DashError);
    try {
      run();
    } catch (e) {
      expect((e as DashError).code).toBe('invalid');
    }
    expect(tables(db)).not.toContain('users2');
    expect(migrationId(db, 'news')).toBe(0);
  });

  it.each([
    'DROP TABLE kv',
    'ALTER TABLE kv ADD COLUMN z TEXT',
    'INSERT INTO kv (module_id, key, value) VALUES (1,2,3)',
    'INSERT OR REPLACE INTO kv VALUES (1,2,3)',
    'REPLACE INTO kv VALUES (1,2,3)',
    'UPDATE kv SET value = 1',
    'DELETE FROM kv',
    'CREATE INDEX evil ON kv (key)',
    'CREATE TRIGGER evil AFTER INSERT ON kv BEGIN SELECT 1; END',
    'ALTER TABLE m_news_a RENAME TO kv_copy',
    'CREATE TABLE IF NOT EXISTS "kv" (a)',
    'create table `kv` (a)',
    'CREATE TABLE m_news_a (x); CREATE TABLE sneaky (y);',
    'CREATE TABLE m_other_a (x)',
  ])('migrateModule rejects %s', (sql) => {
    const db = memDb();
    expect(() => migrateModule(db, 'news', [{ id: 1, up: sql }])).toThrowError(
      expect.objectContaining({ code: 'invalid' }),
    );
    expect(migrationId(db, 'news')).toBe(0);
  });

  it('migrateModule accepts prefixed indexes, triggers and quoted names; hyphen becomes underscore', () => {
    const db = memDb();
    migrateModule(db, 'my-mod', [
      {
        id: 1,
        up: `CREATE TABLE IF NOT EXISTS "m_my_mod_t" (id INTEGER PRIMARY KEY, v TEXT);
             CREATE INDEX m_my_mod_t_v ON m_my_mod_t (v);
             CREATE TRIGGER m_my_mod_trg AFTER INSERT ON m_my_mod_t BEGIN UPDATE m_my_mod_t SET v = 'x' WHERE id = NEW.id; END;`,
      },
    ]);
    expect(tables(db)).toContain('m_my_mod_t');
  });

  it('failed migration rolls back and leaves migration_id unchanged', () => {
    const db = memDb();
    migrateModule(db, 'news', [{ id: 1, up: 'CREATE TABLE m_news_a (x INTEGER);' }]);
    const bad = {
      id: 2,
      up: 'CREATE TABLE m_news_b (y INTEGER); INSERT INTO m_news_missing VALUES (1);',
    };
    expect(() => migrateModule(db, 'news', [{ id: 1, up: 'x' }, bad])).toThrow();
    expect(migrationId(db, 'news')).toBe(1);
    expect(tables(db)).not.toContain('m_news_b');
  });

  it('migrateModule rejects non-ascending or duplicate ids', () => {
    const db = memDb();
    expect(() =>
      migrateModule(db, 'news', [
        { id: 1, up: 'CREATE TABLE m_news_a (x)' },
        { id: 1, up: 'CREATE TABLE m_news_b (x)' },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'invalid' }));
  });
});

describe('backupTo', () => {
  it('writes a consistent copy', async () => {
    const dir = tmp();
    const db = openDb(path.join(dir, 'src.db'));
    migrateCore(db);
    db.prepare("INSERT INTO kv (module_id, key, value) VALUES ('m','k','1')").run();
    const dest = path.join(dir, 'backup.db');
    await backupTo(db, dest);
    expect(existsSync(dest)).toBe(true);
    const copy = openDb(dest);
    expect(copy.prepare('SELECT value FROM kv').all()).toEqual([{ value: '1' }]);
    copy.close();
    db.close();
  });
});
