import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/core/db.ts';
import { migrateCore, migrateModule } from '../../src/core/migrate.ts';

function memDb() {
  const db = openDb(':memory:');
  migrateCore(db);
  return db;
}
function tables(db: ReturnType<typeof memDb>): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(
    (r) => r.name,
  );
}

describe('migrateModule scope scan: bypass attempts are rejected', () => {
  it.each([
    ["INSERT INTO m_news_a VALUES ('--'); DROP TABLE kv;"],
    ["INSERT INTO m_news_a VALUES ('/*'); DROP TABLE kv; INSERT INTO m_news_a VALUES ('*/');"],
    ["DROP TABLE 'kv'"],
    ["DELETE FROM 'kv'"],
    ["INSERT INTO 'kv' VALUES (1,2,3)"],
    ["UPDATE 'kv' SET value = 1"],
    ["CREATE TABLE 'users2' (a)"],
    ['DROP TABLE main.kv'],
    ['DROP TABLE temp.m_news_a'],
    ['DROP TABLE "temp"."m_news_a"'],
    ['DROP TABLE'],
    ['DROP TABLE ;'],
    ['DELETE kv'],
    ['CREATE kv'],
    ['ALTER TABLE m_news_a RENAME TO'],
    ["INSERT INTO m_news_a VALUES ('unterminated); DROP TABLE kv"],
    ['/* unterminated comment DROP TABLE kv'],
    ['ATTACH DATABASE "x.db" AS x'],
    ['PRAGMA writable_schema = 1'],
    ['CREATE TRIGGER m_news_t AFTER INSERT ON m_news_a BEGIN DELETE FROM kv; END'],
  ])('rejects %s', (sql) => {
    const db = memDb();
    db.exec('CREATE TABLE m_news_a (x)');
    expect(() => migrateModule(db, 'news', [{ id: 1, up: sql }])).toThrowError(
      expect.objectContaining({ code: 'invalid' }),
    );
    expect(tables(db)).toContain('kv');
  });
});

describe('migrateModule scope scan: legitimate migrations pass', () => {
  it('accepts string literals containing comment markers and SQL keywords', () => {
    const db = memDb();
    migrateModule(db, 'news', [
      {
        id: 1,
        up: `CREATE TABLE m_news_a (x TEXT); -- DROP TABLE kv in a comment
             /* DELETE FROM kv */
             INSERT INTO m_news_a VALUES ('--');
             INSERT INTO m_news_a VALUES ('/*');
             INSERT INTO m_news_a VALUES ('DROP TABLE kv');
             INSERT INTO m_news_a VALUES ('it''s; DELETE FROM kv');`,
      },
    ]);
    const rows = db.prepare('SELECT x FROM m_news_a').all() as { x: string }[];
    expect(rows.map((r) => r.x)).toEqual(['--', '/*', 'DROP TABLE kv', "it's; DELETE FROM kv"]);
  });

  it('accepts multi-statement, index, trigger and rename migrations', () => {
    const db = memDb();
    migrateModule(db, 'news', [
      {
        id: 1,
        up: `CREATE TABLE m_news_t (id INTEGER PRIMARY KEY, v TEXT);
             CREATE TABLE 'm_news_log' (n INTEGER);
             CREATE INDEX m_news_t_v ON m_news_t (v);
             CREATE TRIGGER m_news_trg AFTER UPDATE OF v ON m_news_t
               BEGIN UPDATE m_news_log SET n = n + 1; INSERT INTO m_news_log VALUES (1); END;
             INSERT INTO m_news_t (v) VALUES ('a') ON CONFLICT(id) DO UPDATE SET v = 'b';`,
      },
      { id: 2, up: 'ALTER TABLE m_news_t RENAME TO m_news_t2;' },
      { id: 3, up: 'ALTER TABLE main.m_news_t2 ADD COLUMN w TEXT; DROP TABLE IF EXISTS main."m_news_log";' },
    ]);
    expect(tables(db)).toContain('m_news_t2');
    expect(tables(db)).not.toContain('m_news_log');
  });
});
