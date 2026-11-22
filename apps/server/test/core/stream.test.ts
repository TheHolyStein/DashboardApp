import { EventEmitter } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { LoggerLike } from '../../src/core/modules/deps.ts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type BetterSqlite3 from 'better-sqlite3';
import type { PermissionLevel, StreamEvent as StreamEventSchema } from '@dash/contract';
import type { z } from 'zod';
import { buildApp } from '../../src/core/app.ts';
import { loadConfig } from '../../src/core/config.ts';
import { openDb } from '../../src/core/db.ts';
import { migrateCore } from '../../src/core/migrate.ts';
import { createSnapshots, type Snapshots } from '../../src/core/snapshots.ts';
import { createStream, type StreamService } from '../../src/core/stream.ts';
import { createVisibility } from '../../src/core/visibility.ts';
import { TEST_USERS, testAuth } from './helpers.ts';
import { manifestFor, silentLogger } from './module-env.ts';

type Ev = z.infer<typeof StreamEventSchema>;
type SnapEv = Extract<Ev, { type: 'snapshot' }>;

const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

let db: BetterSqlite3.Database;
let clock: number;
let auth: ReturnType<typeof testAuth>;
let grantCb: (u: string, m: string, l: PermissionLevel) => void;
let snaps: Snapshots;
let stream: StreamService;
let timers: { handle: unknown; fn?: () => void; cleared: number };
let manifests: typeof baseManifests;
let warn: Mock;
let logger: LoggerLike;
const open: FastifyInstance[] = [];

const baseManifests = [
  manifestFor('weather', {
    jobs: [{ name: 'poll', intervalSec: 60, mode: 'always', per: 'module' }],
    tile: { default: { w: 2, h: 2 }, min: { w: 1, h: 1 }, max: { w: 4, h: 4 }, staleAfterSec: 100 },
  }),
  manifestFor('secret'),
  manifestFor('notes'),
];

function seed(): void {
  db.exec(`
    INSERT INTO pages (id, owner_id, name, shared) VALUES
      ('pa', 'alice', 'A', 0), ('pb', 'bob', 'B', 0), ('ps', 'bob', 'S', 1);
    INSERT INTO instances (id, module_id, page_id) VALUES
      ('i-a-weather', 'weather', 'pa'),
      ('i-b-weather', 'weather', 'pb'),
      ('i-b-secret', 'secret', 'pb'),
      ('i-s-secret', 'secret', 'ps'),
      ('i-a-notes', 'notes', 'pa'),
      ('i-b-notes', 'notes', 'pb');
  `);
}

beforeEach(() => {
  db = openDb(':memory:');
  migrateCore(db);
  seed();
  manifests = [...baseManifests];
  clock = T0;
  auth = testAuth({ defaultLevel: 'view' });
  auth.onGrantsChanged = (cb) => {
    grantCb = cb;
  };
  warn = vi.fn();
  logger = { ...silentLogger, warn };
  timers = { handle: undefined, cleared: 0 };
  const now = (): Date => new Date(clock);
  snaps = createSnapshots({
    db,
    now,
    manifests: (id) => manifests.find((m) => m.id === id),
    logger,
    onStored: (m, i, s) => stream.sendSnapshot(m, i, s),
  });
  stream = createStream({
    auth,
    snapshots: snaps,
    visibility: createVisibility(db, () => Object.keys(TEST_USERS)),
    now,
    logger,
    timers: {
      setInterval: (fn) => {
        timers.fn = fn;
        timers.handle = {};
        return timers.handle;
      },
      clearInterval: () => {
        timers.cleared++;
        timers.handle = undefined;
      },
    },
  });
});

afterEach(async () => {
  stream.close();
  for (const a of open.splice(0)) await a.close();
  db.close();
});

interface Client {
  events: Ev[];
  out: PassThrough;
  headers: Record<string, string>;
  snapshots(): SnapEv['snapshot'][];
  closed(): boolean;
}

/** Calls stream.handle with a fake request/reply; collects what the connection writes. */
function connect(userId: string, opts: { drain?: boolean } = {}): Client {
  const raw = new EventEmitter();
  const req = { user: TEST_USERS[userId], raw } as unknown as FastifyRequest;
  const headers: Record<string, string> = {};
  let out!: PassThrough;
  const reply = {
    header(k: string, v: string) {
      headers[k] = v;
      return reply;
    },
    send(p: PassThrough) {
      out = p;
      return reply;
    },
  } as unknown as FastifyReply;
  stream.handle(req, reply);
  const events: Ev[] = [];
  if (opts.drain !== false) {
    let buf = '';
    out.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const msg = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (msg.startsWith('data: ')) events.push(JSON.parse(msg.slice(6)) as Ev);
      }
    });
  }
  return {
    events,
    out,
    headers,
    snapshots: () => events.filter((e): e is SnapEv => e.type === 'snapshot').map((e) => e.snapshot),
    closed: () => out.destroyed || out.writableEnded,
  };
}

describe('live stream', () => {
  it('connect sends current snapshots for visible instances only', async () => {
    snaps.push('weather', 'i-a-weather', { t: 1 });
    snaps.push('weather', 'i-b-weather', { t: 2 });
    snaps.push('notes', 'i-b-notes', { n: 1 });
    const c = connect('alice');
    await flush();
    // alice: own page (i-a-weather) plus the shared page (only 'secret' there, no snapshot yet)
    expect(c.snapshots().map((s) => s.instanceId)).toEqual(['i-a-weather']);
    expect(c.headers['Content-Type']).toBe('text/event-stream');
    expect(c.headers['Cache-Control']).toBe('no-store');
    expect(c.headers['X-Accel-Buffering']).toBe('no');
  });

  it('user without grant never receives the module\'s snapshots', async () => {
    auth.grants['alice:secret'] = 'none';
    snaps.push('secret', 'i-s-secret', { s: 1 });
    const alice = connect('alice');
    const bob = connect('bob');
    await flush();
    snaps.push('secret', 'i-s-secret', { s: 2 });
    snaps.push('secret', null, { s: 3 });
    await flush();
    expect(alice.snapshots().filter((s) => s.instanceId.includes('secret'))).toEqual([]);
    expect(bob.snapshots().filter((s) => s.instanceId === 'i-s-secret').map((s) => s.data)).toEqual([
      { s: 1 },
      { s: 2 },
      { s: 2 }, // the module-wide push does not override the instance's own snapshot
    ]);
  });

  it('revoking grant sends revoked then no further snapshots', async () => {
    snaps.push('weather', 'i-a-weather', { t: 1 });
    const c = connect('alice');
    await flush();
    auth.grants['alice:weather'] = 'none';
    grantCb('alice', 'weather', 'none');
    snaps.push('weather', 'i-a-weather', { t: 2 });
    await flush();
    expect(c.events.map((e) => e.type)).toEqual(['snapshot', 'revoked']);
    expect(c.events[1]).toEqual({ type: 'revoked', moduleId: 'weather' });
  });

  it('grant from none to view sends current snapshots', async () => {
    auth.grants['alice:weather'] = 'none';
    snaps.push('weather', 'i-a-weather', { t: 1 });
    const c = connect('alice');
    await flush();
    expect(c.snapshots()).toEqual([]);
    auth.grants['alice:weather'] = 'view';
    grantCb('alice', 'weather', 'view');
    snaps.push('weather', 'i-a-weather', { t: 2 });
    await flush();
    expect(c.snapshots().map((s) => s.data)).toEqual([{ t: 1 }, { t: 2 }]);
  });

  it('module-wide snapshot (instanceId null) reaches all instances\' viewers', async () => {
    const alice = connect('alice');
    const bob = connect('bob');
    await flush();
    snaps.push('notes', null, { shared: true });
    await flush();
    expect(alice.snapshots()).toMatchObject([{ instanceId: 'i-a-notes', data: { shared: true } }]);
    expect(bob.snapshots()).toMatchObject([{ instanceId: 'i-b-notes', data: { shared: true } }]);
  });

  it('snapshot becomes stale after staleAfterSec', async () => {
    snaps.push('weather', 'i-a-weather', { t: 1 });
    clock = T0 + 100_000;
    let c = connect('alice');
    await flush();
    expect(c.snapshots()[0]?.stale).toBe(false);
    clock = T0 + 101_000;
    c = connect('alice');
    await flush();
    expect(c.snapshots()[0]).toMatchObject({ stale: true, updatedAt: '2026-11-12T10:00:00.000Z' });
  });

  it('stale defaults to 2.5 x the feeding job interval and a failed job is stale', () => {
    const m = manifestFor('weather', { jobs: [{ name: 'poll', intervalSec: 60, mode: 'always', per: 'module' }] });
    manifests[0] = m;
    snaps.push('weather', 'i-a-weather', { t: 1 });
    clock = T0 + 150_000;
    expect(snaps.toDto(snaps.get('weather', 'i-a-weather')!, 'i-a-weather').stale).toBe(false);
    clock = T0 + 151_000;
    expect(snaps.toDto(snaps.get('weather', 'i-a-weather')!, 'i-a-weather').stale).toBe(true);
    clock = T0;
    snaps.push('weather', 'i-a-weather', { t: 2 });
    snaps.markJobFailed('weather', 'i-a-weather');
    expect(snaps.toDto(snaps.get('weather', 'i-a-weather')!, 'i-a-weather').stale).toBe(true);
    // no jobs and no staleAfterSec: never stale by age
    snaps.push('notes', 'i-a-notes', {});
    clock = T0 + 10 * 86_400_000;
    expect(snaps.toDto(snaps.get('notes', 'i-a-notes')!, 'i-a-notes').stale).toBe(false);
  });

  it('7th stream closes the 1st', () => {
    const cs = Array.from({ length: 6 }, () => connect('alice'));
    expect(cs.map((c) => c.closed())).toEqual(Array(6).fill(false));
    const seventh = connect('alice');
    expect(cs[0]?.closed()).toBe(true);
    expect(cs.slice(1).every((c) => !c.closed())).toBe(true);
    expect(seventh.closed()).toBe(false);
  });

  it('core snapshot is replayed on connect and honors userIds', async () => {
    stream.sendCore('sun', { isDay: true });
    stream.sendCore('offline', { devices: 1 }, ['bob']);
    const alice = connect('alice');
    const bob = connect('bob');
    await flush();
    expect(alice.snapshots()).toMatchObject([{ instanceId: 'core:sun', data: { isDay: true }, stale: false }]);
    expect(bob.snapshots().map((s) => s.instanceId).sort()).toEqual(['core:offline', 'core:sun']);
    stream.sendCore('sun', { isDay: false });
    await flush();
    expect(alice.snapshots().at(-1)?.data).toEqual({ isDay: false });
    expect(db.prepare('SELECT count(*) FROM snapshots').pluck().get()).toBe(0);
  });

  it('snapshot over 256 KB is rejected and not stored', async () => {
    const c = connect('alice');
    await flush();
    expect(() => snaps.push('weather', 'i-a-weather', { big: 'x'.repeat(256 * 1024) })).toThrow(
      expect.objectContaining({ code: 'invalid' }),
    );
    expect(() => snaps.push('weather', 'i-a-weather', undefined)).toThrow(expect.objectContaining({ code: 'invalid' }));
    await flush();
    expect(db.prepare('SELECT count(*) FROM snapshots').pluck().get()).toBe(0);
    expect(c.snapshots()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    snaps.push('weather', 'i-a-weather', { ok: 'x'.repeat(200 * 1024) });
    expect(db.prepare('SELECT count(*) FROM snapshots').pluck().get()).toBe(1);
  });

  it('push upserts one row per module and instance, including module-wide', () => {
    snaps.push('notes', null, { a: 1 });
    snaps.push('notes', null, { a: 2 });
    snaps.push('notes', 'i-a-notes', { a: 3 });
    snaps.push('notes', 'i-a-notes', { a: 4 });
    expect(db.prepare('SELECT count(*) FROM snapshots').pluck().get()).toBe(2);
    expect(snaps.get('notes', null)?.data).toEqual({ a: 2 });
    expect(snaps.forInstance('notes', 'i-a-notes')?.data).toEqual({ a: 4 });
    expect(snaps.forInstance('notes', 'i-b-notes')?.data).toEqual({ a: 2 });
  });

  it('a slow consumer is closed once more than the limit is queued', async () => {
    const slow = createStream({
      auth,
      snapshots: snaps,
      visibility: createVisibility(db, () => Object.keys(TEST_USERS)),
      now: () => new Date(clock),
      logger,
      timers: { setInterval: () => ({}), clearInterval: () => {} },
      maxQueuedBytes: 100_000,
    });
    stream = slow;
    const c = connect('alice', { drain: false }); // nobody reads
    const ok = connect('bob');
    const big = 'x'.repeat(60_000);
    slow.sendCore('a', { big }, ['alice']);
    expect(c.closed()).toBe(false);
    slow.sendCore('b', { big }, ['alice']);
    slow.sendCore('c', { big }, ['alice']);
    expect(c.out.destroyed).toBe(true);
    await flush();
    expect(ok.closed()).toBe(false);
    expect(ok.snapshots().length).toBe(0);
  });

  it('pings every 25 s and clears the timer when the last stream ends', async () => {
    const c = connect('alice');
    expect(timers.fn).toBeTypeOf('function');
    clock += 25_000;
    timers.fn?.();
    await flush();
    expect(c.events).toEqual([{ type: 'ping', at: new Date(clock).toISOString() }]);
    stream.disconnectUser('alice');
    expect(timers.cleared).toBe(1);
    expect(c.closed()).toBe(true);
  });

  it('disconnectUser with a module mutes it and sends revoked', async () => {
    const c = connect('alice');
    await flush();
    stream.disconnectUser('alice', 'weather');
    snaps.push('weather', 'i-a-weather', { t: 1 });
    await flush();
    expect(c.events).toEqual([{ type: 'revoked', moduleId: 'weather' }]);
  });
});

describe('stream routes', () => {
  async function appWith(markViewed = vi.fn()) {
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }),
      db,
      auth,
      modules: [],
      webDistDir: new URL('.', import.meta.url).pathname,
      logger: false,
      stream,
      scheduler: { markViewed },
    });
    open.push(app);
    return { app, markViewed };
  }
  const post = (app: FastifyInstance, instanceIds: unknown, headers: Record<string, string>) =>
    app.inject({ method: 'POST', url: '/api/stream/view', headers, payload: { instanceIds } });

  it('POST /api/stream/view without CSRF is 403', async () => {
    const { app, markViewed } = await appWith();
    const res = await post(app, ['i-a-weather'], { 'x-test-user': 'alice' });
    expect(res.statusCode).toBe(403);
    const bad = await post(app, ['i-a-weather'], { 'x-test-user': 'alice', 'x-csrf': 'nope' });
    expect(bad.statusCode).toBe(403);
    expect((await post(app, [], {})).statusCode).toBe(401);
    expect(markViewed).not.toHaveBeenCalled();
  });

  it('POST /api/stream/view ignores ids the user cannot see', async () => {
    auth.grants['alice:notes'] = 'none';
    const { app, markViewed } = await appWith();
    const res = await post(app, ['i-a-weather', 'i-b-weather', 'i-b-secret', 'i-s-secret', 'i-a-notes', 'nope'], {
      'x-test-user': 'alice',
      'x-csrf': 'csrf-alice',
    });
    expect(res.statusCode).toBe(204);
    expect(markViewed).toHaveBeenCalledOnce();
    const [ids, at] = markViewed.mock.calls[0] as [string[], Date];
    expect(ids.sort()).toEqual(['i-a-weather', 'i-s-secret']);
    expect(at.getTime()).toBe(T0);
  });

  it('POST /api/stream/view accepts at most 200 ids', async () => {
    const { app } = await appWith();
    const h = { 'x-test-user': 'alice', 'x-csrf': 'csrf-alice' };
    expect((await post(app, Array.from({ length: 200 }, (_, i) => `x${i}`), h)).statusCode).toBe(204);
    expect((await post(app, Array.from({ length: 201 }, (_, i) => `x${i}`), h)).statusCode).toBe(422);
  });

  it('GET /api/stream over real HTTP: SSE and security headers, 401 without session, closed on app close', async () => {
    snaps.push('weather', 'i-a-weather', { t: 1 });
    const { app } = await appWith();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const get = (headers: Record<string, string>) =>
      new Promise<http.IncomingMessage>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/api/stream', agent: false, headers }, resolve).on('error', reject);
      });
    
    const unauth = await get({});
    expect(unauth.statusCode).toBe(401);
    unauth.resume();

    const res = await get({ 'x-test-user': 'alice' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    let body = '';
    res.setEncoding('utf8');
    const ended = new Promise<void>((r) => res.on('close', () => r()));
    await new Promise<void>((resolve) =>
      res.on('data', (d: string) => {
        body += d;
        if (body.includes('i-a-weather')) resolve();
      }),
    );
    expect(body).toContain('data: {"type":"snapshot"');
    await app.close();
    open.length = 0;
    await ended;
  });
});
