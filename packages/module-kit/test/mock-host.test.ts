import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DashError } from '@dash/contract';
import { defineServer } from '../src/index.js';
import { applyMigrations, createMockHost, createMockRouter, loadFixture } from '../src/testing.js';
import { goodServer } from './sample-module/good/server.js';
import { goodManifest } from './sample-module/good/manifest.js';
import path from 'node:path';

const goodDir = path.join(import.meta.dirname, 'sample-module', 'good');

describe('mock host', () => {
  it('respond() matches by substring, returns data and records the request', async () => {
    const host = createMockHost(goodManifest);
    host.respond('example.test/api', { data: { ok: true }, headers: { 'x-a': '1' } });
    const res = await host.http.fetch('https://example.test/api/x', { method: 'GET' });
    expect(res).toMatchObject({ status: 200, data: { ok: true }, headers: { 'x-a': '1' }, fromCache: false });
    expect(host.requests).toEqual([{ url: 'https://example.test/api/x', opts: { method: 'GET' } }]);
  });

  it('respond() matches RegExp in registration order; no match rejects with upstream', async () => {
    const host = createMockHost(goodManifest);
    host.respond(/first/, { data: 1 });
    host.respond('first', { data: 2 });
    expect((await host.http.fetch('https://a/first')).data).toBe(1);
    await expect(host.http.fetch('https://a/other')).rejects.toMatchObject({ code: 'upstream' });
  });

  it('an Error response rejects with that error', async () => {
    const host = createMockHost(goodManifest);
    const err = new Error('ECONNRESET');
    host.respond('x', err);
    await expect(host.http.fetch('https://x')).rejects.toBe(err);
  });

  it('invalid JSON string data rejects with upstream unless as is text', async () => {
    const host = createMockHost(goodManifest);
    host.respond('x', { data: '<html>not json</html>' });
    await expect(host.http.fetch('https://x')).rejects.toBeInstanceOf(DashError);
    await expect(host.http.fetch('https://x', { as: 'text' })).resolves.toMatchObject({ data: '<html>not json</html>' });
  });

  it("'hang' never resolves by itself and rejects on abortPending()", async () => {
    const host = createMockHost(goodManifest);
    host.respond('slow', 'hang');
    let settled = false;
    const p = host.http.fetch('https://slow').finally(() => (settled = true));
    p.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    host.abortPending();
    await expect(p).rejects.toMatchObject({ code: 'upstream', message: 'aborted' });
  });

  it('advance(1000) moves now()', () => {
    const host = createMockHost(goodManifest, { now: new Date('2026-01-01T00:00:00Z') });
    host.advance(1000);
    expect(host.now().toISOString()).toBe('2026-01-01T00:00:01.000Z');
    host.setNow(new Date('2027-01-01T00:00:00Z'));
    expect(host.now().getUTCFullYear()).toBe(2027);
  });

  it('store.set/get/delete/keys round-trip, blob and secrets work', async () => {
    const host = createMockHost(goodManifest);
    await host.store.set('a:1', { v: 1 });
    await host.store.set('b:1', 2);
    expect(await host.store.get('a:1')).toEqual({ v: 1 });
    expect(await host.store.keys('a:')).toEqual(['a:1']);
    await host.store.delete('a:1');
    expect(await host.store.get('a:1')).toBeUndefined();
    await host.store.blob.put('k', new Uint8Array([1]), 'image/png');
    expect((await host.store.blob.get('k'))?.contentType).toBe('image/png');
    await host.secrets.set('s', 'v');
    expect(await host.secrets.get('s')).toBe('v');
  });

  it('push, bus.publish and notify are recorded; notifications absent by default', () => {
    const host = createMockHost(goodManifest);
    host.push(null, { a: 1 });
    host.bus.publish('timer.finished', { id: 'x', label: 'y' });
    host.notify({ level: 'info', title: 't' });
    expect(host.pushed).toEqual([{ instanceId: null, data: { a: 1 } }]);
    expect(host.published).toEqual([{ name: 'timer.finished', payload: { id: 'x', label: 'y' } }]);
    expect(host.notified).toHaveLength(1);
    expect(host.notifications).toBeUndefined();
  });

  it('config/instances/users reflect setters', async () => {
    const host = createMockHost(goodManifest);
    host.setConfig({ a: 1 });
    host.setUsers([{ id: 'u', name: 'U', handle: 'u' }]);
    host.setInstances([{ id: 'i', ownerId: 'u', pageId: 'p', settings: {} }]);
    expect(await host.config()).toEqual({ a: 1 });
    expect(await host.users()).toEqual([{ id: 'u', name: 'U', handle: 'u', role: 'member', timeZone: 'UTC' }]);
    host.setUsers([{ id: 'a', name: 'A', handle: 'a', role: 'admin', timeZone: 'Asia/Kolkata' }]);
    expect((await host.users())[0]).toMatchObject({ role: 'admin', timeZone: 'Asia/Kolkata' });
    expect(await host.instances()).toHaveLength(1);
  });

  it('applyMigrations runs several statements per migration like the real runner', () => {
    const host = createMockHost(goodManifest);
    applyMigrations(host, [
      { id: 1, up: 'CREATE TABLE m_sample_t (id INTEGER PRIMARY KEY, v TEXT); CREATE INDEX m_sample_t_v ON m_sample_t (v);' },
    ]);
    const idx = host.store.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'm_sample_t_v'");
    expect(idx).toHaveLength(1);
  });

  it('applyMigrations creates tables in store.db', () => {
    const host = createMockHost(goodManifest);
    applyMigrations(host, [{ id: 1, up: 'CREATE TABLE m_sample_t (id INTEGER PRIMARY KEY, v TEXT)' }]);
    host.store.db.run('INSERT INTO m_sample_t (v) VALUES (?)', ['x']);
    expect(host.store.db.all<{ v: string }>('SELECT v FROM m_sample_t')).toEqual([{ v: 'x' }]);
    expect(host.store.db.transaction(() => 5)).toBe(5);
  });
});

describe('mock router', () => {
  it('collects routes, supports :param, enforces level, validates, maps errors', async () => {
    const host = createMockHost(goodManifest);
    applyMigrations(host, goodServer.migrations ?? []);
    const router = createMockRouter(goodServer, host);
    expect(router.routes.length).toBeGreaterThan(0);
    const ok = await router.call('GET', '/items/abc', { level: 'view' });
    expect(ok).toEqual({ status: 200, body: { id: 'abc' } });
    const denied = await router.call('POST', '/items', { level: 'view', body: { title: 'x' } });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { code: 'forbidden' } });
    expect((await router.call('POST', '/items', { level: 'edit', body: { title: 1 } })).status).toBe(422);
    expect((await router.call('POST', '/items', { level: 'edit', body: { title: 'x' } })).status).toBe(200);
    expect((await router.call('GET', '/boom', { level: 'view' })).status).toBe(404);
    expect((await router.call('GET', '/crash', { level: 'view' })).status).toBe(500);
    expect((await router.call('GET', '/nope', { level: 'view' })).status).toBe(404);
  });
});

describe('mock router: 204', () => {
  it('a handler returning undefined answers 204 without a body; a value answers 200 (sync or async)', async () => {
    const host = createMockHost(goodManifest);
    const server = defineServer({
      manifest: { ...goodManifest, jobs: [], subscribes: [] },
      routes(r) {
        r.delete('/x', { level: 'edit' }, () => undefined);
        r.get('/sync', { level: 'view' }, () => ({ ok: true }));
        r.post('/typed', { level: 'edit', body: z.object({ n: z.number() }) }, (req) => ({ double: req.body.n * 2 }));
      },
    });
    const router = createMockRouter(server, host);
    expect(await router.call('DELETE', '/x', { level: 'edit' })).toEqual({ status: 204, body: undefined });
    expect(await router.call('GET', '/sync', { level: 'view' })).toEqual({ status: 200, body: { ok: true } });
    expect(await router.call('POST', '/typed', { level: 'edit', body: { n: 4 } })).toEqual({ status: 200, body: { double: 8 } });
  });
});

describe('loadFixture', () => {
  it('parses json, returns text for other extensions, throws when missing', () => {
    expect(loadFixture(goodDir, 'sample')).toEqual({ value: 42, label: 'Kitchen' });
    expect(loadFixture<string>(goodDir, 'feed')).toContain('<rss');
    expect(() => loadFixture(goodDir, 'missing')).toThrow(/missing/);
  });
});
