/* eslint-disable @typescript-eslint/require-await */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BinaryResponse, type ModuleServer } from '@dash/contract';
import { ROOT_MOUNT_ALLOW } from '../../src/core/modules/loader.ts';
import { makeModuleEnv, serverFor, type ModuleEnv } from './module-env.ts';

const envs: ModuleEnv[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.app.close();
});
async function env(...args: Parameters<typeof makeModuleEnv>): Promise<ModuleEnv> {
  const e = await makeModuleEnv(...args);
  envs.push(e);
  return e;
}
const as = (user: string, csrf = true): Record<string, string> => ({
  'x-test-user': user,
  ...(csrf ? { 'x-csrf': `csrf-${user}` } : {}),
});
const errOf = (r: { json(): unknown }) => r.json() as { error: { code: string; details?: { in: string; issues: Array<{ path: unknown[] }> } } };

const demo = (id = 'demo') =>
  serverFor(id, (r) => {
    r.get('/hello', { level: 'view' }, async (req) => ({ hi: req.user.name, level: req.level }));
    r.post('/echo', { level: 'view', body: z.object({ n: z.number() }) }, async (req) => req.body);
    r.post('/edit', { level: 'edit' }, async (req) => ({ by: req.user.id, level: req.level }));
    r.get('/nothing', { level: 'view' }, async () => undefined);
    r.get('/q', { level: 'view', query: z.object({ a: z.coerce.number() }) }, async (req) => req.query);
    r.get('/item/:id', { level: 'view' }, async (req) => ({ id: req.params['id'] }));
    r.get('/bin', { level: 'view' }, async () => new BinaryResponse(new Uint8Array([1, 2, 3]), 'image/png', 'max-age=60'));
  });

describe('module loader', () => {
  it('invalid manifest → module skipped, others load', async () => {
    const bad = serverFor('bad', undefined, { manifest: { version: 'nope' } });
    const e = await env([bad, demo()]);
    expect(e.modules.map((m) => [m.id, m.failed === undefined])).toEqual([
      ['bad', false],
      ['demo', true],
    ]);
    expect(e.modules[0]!.failed).toMatch(/semver/);
    const res = await e.app.inject({ url: '/api/m/demo/hello', headers: as('alice') });
    expect(res.statusCode).toBe(200);
    const gone = await e.app.inject({ url: '/api/m/bad/hello', headers: as('alice') });
    expect(gone.statusCode).toBe(404);
  });

  it('rootMount not allow-listed → refused at load', async () => {
    const evil = serverFor('evil', undefined, {
      manifest: { rootMounts: [{ prefix: '/dav', auth: 'appPassword' }] },
    });
    const calendarWrongPrefix = serverFor('calendar', undefined, {
      manifest: { rootMounts: [{ prefix: '/admin', auth: 'session' }] },
    });
    const calendar = serverFor('calendar', undefined, {
      manifest: { rootMounts: [{ prefix: '/dav', auth: 'appPassword' }] },
    });
    const e = await env([evil, calendarWrongPrefix, calendar]);
    expect(e.modules[0]!.failed).toMatch(/not allow-listed/);
    expect(e.modules[1]!.failed).toMatch(/not allow-listed/);
    expect(e.modules[2]!.failed).toBeUndefined();
    expect(ROOT_MOUNT_ALLOW).toEqual({ calendar: ['/dav', '/.well-known/caldav'] });
  });

  it('migration failure, handler mismatch and duplicate ids mark only that module failed', async () => {
    const badMigration = serverFor('badmig', undefined, {
      migrations: [{ id: 1, up: 'CREATE TABLE users2 (x)' }],
    });
    const mismatch = { ...serverFor('mismatch'), jobs: { ghost: async () => {} } } as ModuleServer;
    const first = demo('twin');
    const second = demo('twin');
    const e = await env([badMigration, mismatch, first, second]);
    expect(e.modules.map((m) => m.failed !== undefined)).toEqual([true, true, false, true]);
    expect(e.modules[3]!.failed).toMatch(/duplicate/);
  });

  it('import failure is contained and enabled flag comes from module_state', async () => {
    const e0 = await env([demo('stays')]);
    e0.db.prepare('UPDATE module_state SET enabled = 0 WHERE module_id = ?').run('stays');
    expect(e0.modules[0]!.enabled).toBe(true); // loaded before the update
    const e = await env([async () => { throw new Error('boom'); }, demo('ok')]);
    expect(e.modules[0]!.failed).toBe('boom');
    expect(e.modules[1]!.enabled).toBe(true);
    expect(e.db.prepare('SELECT enabled FROM module_state WHERE module_id = ?').pluck().get('ok')).toBe(1);
  });
});

describe('module router', () => {
  it('route without session → 401', async () => {
    const e = await env([demo()]);
    const res = await e.app.inject({ url: '/api/m/demo/hello' });
    expect(res.statusCode).toBe(401);
    expect(errOf(res).error.code).toBe('unauthenticated');
  });

  it('grant none → 403', async () => {
    const e = await env([demo()], { grants: { 'alice:demo': 'none' } });
    const res = await e.app.inject({ url: '/api/m/demo/hello', headers: as('alice') });
    expect(res.statusCode).toBe(403);
  });

  it('view user on edit route → 403; edit user with right CSRF → 200', async () => {
    const e = await env([demo()], { grants: { 'alice:demo': 'view', 'bob:demo': 'edit' } });
    const denied = await e.app.inject({ method: 'POST', url: '/api/m/demo/edit', headers: as('alice') });
    expect(denied.statusCode).toBe(403);
    const ok = await e.app.inject({ method: 'POST', url: '/api/m/demo/edit', headers: as('bob') });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ by: 'bob', level: 'edit' });
    const wrong = await e.app.inject({
      method: 'POST', url: '/api/m/demo/edit', headers: { 'x-test-user': 'bob', 'x-csrf': 'csrf-alice' },
    });
    expect(wrong.statusCode).toBe(403);
  });

  it('bad body → 422 with zod issues in details', async () => {
    const e = await env([demo()]);
    const res = await e.app.inject({
      method: 'POST', url: '/api/m/demo/echo', headers: as('alice'), payload: { n: 'x' },
    });
    expect(res.statusCode).toBe(422);
    const body = errOf(res);
    expect(body.error.code).toBe('invalid');
    expect(body.error.details?.in).toBe('body');
    expect(body.error.details?.issues[0]?.path).toEqual(['n']);
    const good = await e.app.inject({
      method: 'POST', url: '/api/m/demo/echo', headers: as('alice'), payload: { n: 3 },
    });
    expect(good.json()).toEqual({ n: 3 });
    const q = await e.app.inject({ url: '/api/m/demo/q?a=zz', headers: as('alice') });
    expect(q.statusCode).toBe(422);
    expect(errOf(q).error.details?.in).toBe('query');
    expect((await e.app.inject({ url: '/api/m/demo/q?a=4', headers: as('alice') })).json()).toEqual({ a: 4 });
  });

  it('POST without X-CSRF → 403', async () => {
    const e = await env([demo()]);
    const res = await e.app.inject({
      method: 'POST', url: '/api/m/demo/echo', headers: as('alice', false), payload: { n: 1 },
    });
    expect(res.statusCode).toBe(403);
  });

  it("disabled module's routes return 404", async () => {
    const e = await env([demo()]);
    expect((await e.app.inject({ url: '/api/m/demo/hello', headers: as('alice') })).statusCode).toBe(200);
    e.modules[0]!.enabled = false; // evaluated per request
    expect((await e.app.inject({ url: '/api/m/demo/hello', headers: as('alice') })).statusCode).toBe(404);
    expect((await e.app.inject({ url: '/api/m/demo/hello' })).statusCode).toBe(401); // auth first
  });

  it('level is evaluated per request and unknown paths 404', async () => {
    const e = await env([demo()]);
    expect((await e.app.inject({ url: '/api/m/demo/hello', headers: as('alice') })).statusCode).toBe(200);
    e.auth.grants['alice:demo'] = 'none';
    expect((await e.app.inject({ url: '/api/m/demo/hello', headers: as('alice') })).statusCode).toBe(403);
    expect((await e.app.inject({ url: '/api/m/demo/nope', headers: as('alice') })).statusCode).toBe(403);
    e.auth.grants['alice:demo'] = 'view';
    const nf = await e.app.inject({ url: '/api/m/demo/nope', headers: as('alice') });
    expect(nf.statusCode).toBe(404);
    expect(errOf(nf).error.code).toBe('not_found');
  });

  it('passes user, level, params; undefined → 204; BinaryResponse headers', async () => {
    const e = await env([demo()], { grants: { 'alice:demo': 'view' } });
    expect((await e.app.inject({ url: '/api/m/demo/hello', headers: as('alice') })).json()).toEqual({
      hi: 'Alice', level: 'view',
    });
    expect((await e.app.inject({ url: '/api/m/demo/item/42', headers: as('alice') })).json()).toEqual({ id: '42' });
    expect((await e.app.inject({ url: '/api/m/demo/nothing', headers: as('alice') })).statusCode).toBe(204);
    const bin = await e.app.inject({ url: '/api/m/demo/bin', headers: as('alice') });
    expect(bin.statusCode).toBe(200);
    expect(bin.headers['content-type']).toBe('image/png');
    expect(bin.headers['x-content-type-options']).toBe('nosniff');
    expect(bin.headers['cache-control']).toBe('max-age=60');
    expect([...bin.rawPayload]).toEqual([1, 2, 3]);
  });
});

describe('raw root mounts', () => {
  const calendar = (auth: 'appPassword' | 'session') =>
    serverFor(
      'calendar',
      (r) =>
        r.raw('/dav', async (req) => ({
          status: 207,
          headers: { 'content-type': 'application/xml' },
          body: `${req.method} ${req.path} ${req.rawBody.toString()} ${req.user.id} ${req.level}`,
        })),
      { manifest: { rootMounts: [{ prefix: '/dav', auth }] } },
    );
  const basic = `Basic ${Buffer.from('secret').toString('base64')}`;

  it('appPassword mount: 401 without credentials, PROPFIND receives rawBody, no CSRF needed', async () => {
    const e = await env([calendar('appPassword')], { appPassword: 'secret' });
    const none = await e.app.inject({ method: 'GET', url: '/dav/' });
    expect(none.statusCode).toBe(401);
    expect(none.headers['www-authenticate']).toMatch(/^Basic/);
    const res = await e.app.inject({
      method: 'PROPFIND' as never,
      url: '/dav/cal/1',
      headers: { authorization: basic, 'content-type': 'application/xml' },
      payload: '<propfind/>',
    });
    expect(res.statusCode).toBe(207);
    expect(res.body).toBe('PROPFIND /dav/cal/1 <propfind/> alice edit');
    const put = await e.app.inject({
      method: 'PUT', url: '/dav', headers: { authorization: basic, 'content-type': 'text/calendar' }, payload: 'BEGIN',
    });
    expect(put.body).toBe('PUT /dav BEGIN alice edit');
    const report = await e.app.inject({
      method: 'REPORT' as never, url: '/dav/x', headers: { authorization: basic }, payload: 'raw',
    });
    expect(report.body).toContain('REPORT /dav/x raw');
  });

  it('appPassword mount still needs level >= view; disabled → 404', async () => {
    const e = await env([calendar('appPassword')], { appPassword: 'secret', grants: { 'alice:calendar': 'none' } });
    const res = await e.app.inject({ url: '/dav/x', headers: { authorization: basic } });
    expect(res.statusCode).toBe(403);
    e.auth.grants['alice:calendar'] = 'view';
    expect((await e.app.inject({ url: '/dav/x', headers: { authorization: basic } })).statusCode).toBe(207);
    e.modules[0]!.enabled = false;
    expect((await e.app.inject({ url: '/dav/x', headers: { authorization: basic } })).statusCode).toBe(404);
  });

  it('session mount uses session and CSRF rules', async () => {
    const e = await env([calendar('session')]);
    expect((await e.app.inject({ url: '/dav/x' })).statusCode).toBe(401);
    expect((await e.app.inject({ url: '/dav/x', headers: as('alice') })).statusCode).toBe(207);
    const noCsrf = await e.app.inject({ method: 'PUT', url: '/dav/x', headers: as('alice', false), payload: 'a' });
    expect(noCsrf.statusCode).toBe(403);
    expect((await e.app.inject({ method: 'PUT', url: '/dav/x', headers: as('alice'), payload: 'a' })).statusCode).toBe(207);
  });

  it('raw() for a prefix the manifest does not declare marks the module failed', async () => {
    const sneaky = serverFor('calendar', (r) => r.raw('/dav', async () => ({ status: 200 })), {
      manifest: { rootMounts: [] },
    });
    const e = await env([sneaky]);
    expect(e.modules[0]!.failed).toMatch(/not allowed/);
    expect((await e.app.inject({ url: '/dav/x', headers: as('alice') })).statusCode).toBe(404);
  });
});

describe('host', () => {
  const create = async (id = 'notes') => {
    const e = await env([
      serverFor(id, undefined, {
        migrations: [{ id: 1, up: `CREATE TABLE m_${id}_t (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE m_${id}_u (id INTEGER, t INTEGER);` }],
      }),
    ]);
    return { e, host: e.modules[0]!.host };
  };

  it("host.store.db rejects 'SELECT * FROM users'", async () => {
    const { host } = await create();
    expect(() => host.store.db.all('SELECT * FROM users')).toThrow(/prefix/);
  });

  it('store.db works on own tables, including joins, CTEs, subqueries and transactions', async () => {
    const { host } = await create();
    const db = host.store.db;
    expect(db.run('INSERT INTO m_notes_t (v) VALUES (?)', ['a'])).toEqual({ changes: 1 });
    db.transaction(() => {
      db.run('INSERT INTO m_notes_t (v) VALUES (?);', ['b']);
      db.run('INSERT INTO m_notes_u (id, t) SELECT id, id FROM m_notes_t');
    });
    expect(db.all<{ v: string }>('SELECT v FROM m_notes_t ORDER BY id').map((r) => r.v)).toEqual(['a', 'b']);
    expect(db.get<{ n: number }>('SELECT count(*) AS n FROM m_notes_t t JOIN m_notes_u u ON u.t = t.id')?.n).toBe(2);
    expect(db.all('WITH c AS (SELECT id FROM m_notes_t) SELECT * FROM c WHERE id IN (SELECT t FROM m_notes_u)')).toHaveLength(2);
    expect(db.all("SELECT 'FROM users' AS s, (SELECT 1) AS x FROM m_notes_t")).toHaveLength(2);
    expect(db.all("SELECT value FROM json_each('[1,2]')")).toHaveLength(2);
    expect(db.run('UPDATE m_notes_t SET v = ? WHERE id IN (SELECT t FROM m_notes_u)', ['z']).changes).toBe(2);
    expect(db.run('DELETE FROM m_notes_u').changes).toBe(2);
  });

  it('store.db rejects writes to core tables, multi-statement strings and unclassifiable SQL', async () => {
    const { host, e } = await create();
    const db = host.store.db;
    e.db.prepare("INSERT INTO kv (module_id, key, value) VALUES ('x','k','1')").run();
    const bad = [
      "DELETE FROM kv",
      "INSERT INTO kv (module_id, key, value) VALUES ('notes','a','1')",
      "UPDATE m_notes_t SET v = 1; DELETE FROM kv",
      'SELECT 1; SELECT 2',
      'DROP TABLE m_notes_t',
      'CREATE TABLE m_notes_x (a)',
      'PRAGMA table_info(kv)',
      'ATTACH DATABASE "x" AS y',
      'SELECT * FROM sqlite_master',
      'SELECT * FROM main.kv',
      'SELECT * FROM m_notes_t, kv',
      'SELECT * FROM m_notes_t JOIN m_notes_u ON 1 = 1, kv',
      'SELECT * FROM (kv)',
      'SELECT * FROM (m_notes_t, kv)',
      'SELECT * FROM m_notes_t WHERE id IN kv',
      'SELECT * FROM m_notes_t WHERE id IN (SELECT 1 FROM kv)',
      'SELECT * FROM pragma_table_info("kv")',
      'SELECT (SELECT count(*) FROM kv) FROM m_notes_t',
      'INSERT INTO m_notes_t (v) SELECT key FROM kv',
      'WITH kv2 AS (SELECT * FROM kv) DELETE FROM kv',
      'WITH kv AS (SELECT * FROM kv) SELECT * FROM kv',
      'SELECT * FROM (WITH c AS (SELECT 1) SELECT * FROM c), c',
      "SELECT * FROM m_notes_t -- \n, kv",
      'SELECT * FROM /* x */ kv',
      "SELECT 'unterminated",
      '',
      'VACUUM',
      'EXPLAIN SELECT 1',
      'SELECT * FROM "kv"',
      'SELECT * FROM [kv]',
    ];
    for (const sql of bad) expect(() => db.all(sql), sql).toThrow();
    expect(e.db.prepare('SELECT count(*) FROM kv').pluck().get()).toBe(1);
  });

  it('wires moduleId, bus, push, notify, config, instances, users, log and clock', async () => {
    const { host, e } = await create();
    expect(host.moduleId).toBe('notes');
    host.push('i1', { a: 1 });
    host.push(null, { b: 2 });
    host.notify({ level: 'info', title: 'T' });
    host.bus.publish('timer.finished', { id: '1', label: 'x' });
    expect(e.fakes.pushed).toEqual([
      { moduleId: 'notes', instanceId: 'i1', data: { a: 1 } },
      { moduleId: 'notes', instanceId: null, data: { b: 2 } },
    ]);
    expect(e.fakes.notified).toEqual([{ moduleId: 'notes', title: 'T' }]);
    expect(e.fakes.published[0]).toMatchObject({ from: 'notes', name: 'timer.finished' });
    expect(await host.config()).toEqual({});
    expect(await host.instances()).toEqual([]);
    expect(await host.users()).toEqual([
      { id: 'alice', name: 'Alice', handle: 'alice' },
      { id: 'bob', name: 'Bob', handle: 'bob' },
    ]);
    expect(host.notifications).toBeUndefined();
    expect(host.now().toISOString()).toBe('2026-11-12T10:00:00.000Z');
    expect(() => host.log.info('hi', { a: 1 })).not.toThrow();
  });
});
