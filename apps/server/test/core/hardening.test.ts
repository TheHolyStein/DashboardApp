/* eslint-disable @typescript-eslint/require-await */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/core/app.ts';
import { loadConfig } from '../../src/core/config.ts';
import { openDb } from '../../src/core/db.ts';
import { migrateCore } from '../../src/core/migrate.ts';
import { createNotifications } from '../../src/core/notifications.ts';
import { makeModuleEnv, serverFor, silentLogger, type ModuleEnv } from './module-env.ts';
import { stubAuth } from './helpers.ts';

const envs: ModuleEnv[] = [];
const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (envs.length) await envs.pop()!.app.close();
  while (apps.length) await apps.pop()!.close();
});
async function env(...args: Parameters<typeof makeModuleEnv>): Promise<ModuleEnv> {
  const e = await makeModuleEnv(...args);
  envs.push(e);
  return e;
}
const basic = `Basic ${Buffer.from('secret').toString('base64')}`;

describe('hardening 1: headers handed to module handlers', () => {
  it('never passes cookie; passes authorization only on appPassword root mounts', async () => {
    const seen: Record<string, Record<string, string>> = {};
    const mod = serverFor(
      'calendar',
      (r) => {
        r.get('/h', { level: 'view' }, async (req) => {
          seen['api'] = req.headers;
          return {};
        });
        r.raw('/dav', async (req) => {
          seen['dav'] = req.headers;
          return { status: 200, body: 'ok' };
        });
      },
      { manifest: { rootMounts: [{ prefix: '/dav', auth: 'appPassword' }] } },
    );
    const e = await env([mod], { appPassword: 'secret' });
    const api = await e.app.inject({
      url: '/api/m/calendar/h',
      headers: { 'x-test-user': 'alice', cookie: 'dash_session=abc', authorization: 'Bearer zzz', 'x-other': 'keep' },
    });
    expect(api.statusCode).toBe(200);
    expect(seen['api']).not.toHaveProperty('cookie');
    expect(seen['api']).not.toHaveProperty('authorization');
    expect(seen['api']).toHaveProperty('x-other', 'keep');
    const dav = await e.app.inject({ url: '/dav/x', headers: { authorization: basic, cookie: 'dash_session=abc' } });
    expect(dav.statusCode).toBe(200);
    expect(seen['dav']).not.toHaveProperty('cookie');
    expect(seen['dav']).toHaveProperty('authorization', basic);
  });

  it('a session root mount does not receive authorization either', async () => {
    const seen: Array<Record<string, string>> = [];
    const mod = serverFor(
      'calendar',
      (r) =>
        r.raw('/dav', async (req) => {
          seen.push(req.headers);
          return { status: 200, body: 'ok' };
        }),
      { manifest: { rootMounts: [{ prefix: '/dav', auth: 'session' }] } },
    );
    const e = await env([mod]);
    await e.app.inject({ url: '/dav/x', headers: { 'x-test-user': 'alice', authorization: 'Bearer t', cookie: 'c=1' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('authorization');
    expect(seen[0]).not.toHaveProperty('cookie');
  });
});

describe('hardening 2: CSRF skipped only for appPassword', () => {
  it('an unknown mount auth value still gets the CSRF check', async () => {
    const mod = serverFor(
      'calendar',
      (r) => {
        const mount = (mod.manifest.rootMounts ?? [])[0] as { auth: string };
        mount.auth = 'weird'; // fabricated value, after the loader validated the manifest
        r.raw('/dav', async () => ({ status: 200, body: 'ok' }));
      },
      { manifest: { rootMounts: [{ prefix: '/dav', auth: 'session' }] } },
    );
    const e = await env([mod]);
    const noCsrf = await e.app.inject({ method: 'PUT', url: '/dav/x', headers: { 'x-test-user': 'alice' }, payload: 'a' });
    expect(noCsrf.statusCode).toBe(403);
    const ok = await e.app.inject({
      method: 'PUT', url: '/dav/x', headers: { 'x-test-user': 'alice', 'x-csrf': 'csrf-alice' }, payload: 'a',
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('hardening 3: stream uses the shared csrf helper', () => {
  it('stream.ts has no private csrfOk', () => {
    const src = readFileSync(new URL('../../src/core/stream.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/function csrfOk/);
    expect(src).not.toMatch(/timingSafeEqual/);
    expect(src).toMatch(/from '\.\/csrf\.js'/);
  });
});

describe('hardening 4: notification delivery is isolated per user', () => {
  it('a throwing stream/bus/sink for the first user neither skips the second nor throws into notify', () => {
    const db = openDb(':memory:');
    migrateCore(db);
    const users = ['alice', 'bob'].map((id) => ({ id, name: id, handle: id, role: 'member' as const }));
    const auth = { listUsers: () => users, levelFor: () => 'view' as const };
    const sent: string[] = [];
    const published: string[] = [];
    const sunk: string[] = [];
    const n = createNotifications({
      db,
      auth,
      bus: {
        publish: (_f, _n, p) => {
          const userId = (p as { userId: string }).userId;
          if (userId === 'alice') throw new Error('bus boom');
          published.push(userId);
        },
      },
      stream: {
        sendToUser: (userId) => {
          if (userId === 'alice') throw new Error('stream boom');
          sent.push(userId);
        },
      },
      now: () => new Date('2026-11-12T10:00:00.000Z'),
      logger: silentLogger,
    });
    n.registerNotificationSink(({ userId }) => {
      if (userId === 'alice') throw new Error('sink boom');
      sunk.push(userId);
    });
    expect(() => n.notify('demo', { level: 'info', title: 'Hi' })).not.toThrow();
    expect(sent).toEqual(['bob']);
    expect(published).toEqual(['bob']);
    expect(sunk).toEqual(['bob']);
    expect(db.prepare('SELECT COUNT(*) FROM notifications').pluck().get()).toBe(2);
  });
});

describe('hardening 5: assets detection is relative to the web dist', () => {
  it('index.html is not immutable when the dist path itself contains /assets/', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'dash-x-')), 'assets', 'web');
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>d</title>');
    writeFileSync(join(dir, 'other.txt'), 'x');
    writeFileSync(join(dir, 'assets', 'a-1.js'), '1');
    const db = openDb(':memory:');
    migrateCore(db);
    const app = await buildApp({
      config: loadConfig({ NODE_ENV: 'test' }), db, auth: stubAuth(), modules: [], webDistDir: dir, logger: false,
    });
    apps.push(app);
    expect((await app.inject({ url: '/index.html' })).headers['cache-control']).toBe('no-cache');
    expect((await app.inject({ url: '/other.txt' })).headers['cache-control']).toBe('no-cache');
    expect((await app.inject({ url: '/assets/a-1.js' })).headers['cache-control']).toBe(
      'public, max-age=31536000, immutable',
    );
  });
});
