import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DashError } from '@dash/contract';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/core/app.ts';
import { loadConfig } from '../../src/core/config.ts';
import { openDb } from '../../src/core/db.ts';
import { migrateCore } from '../../src/core/migrate.ts';
import { stubAuth } from './helpers.ts';

const errOf = (r: { json(): unknown }) => r.json() as { error: { code: string } };
const apps: FastifyInstance[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

function webDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dash-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>dash</title>');
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)');
  return dir;
}

async function make(webDir?: string): Promise<FastifyInstance> {
  const config = loadConfig({ NODE_ENV: 'test' });
  const db = openDb(':memory:');
  migrateCore(db);
  const app = await buildApp({
    config,
    db,
    auth: stubAuth(),
    modules: [],
    webDistDir: webDir ?? webDist(),
    logger: false,
  });
  apps.push(app);
  return app;
}

describe('app', () => {
  it('GET /api/health → {ok:true, contract:1}', async () => {
    const app = await make();
    const res = await app.inject({ url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; contract: number; version: unknown }>();
    expect(body.ok).toBe(true);
    expect(body.contract).toBe(2);
    expect(typeof body.version).toBe('string');
  });

  it('binds 127.0.0.1 only', () => {
    expect(loadConfig({}).host).toBe('127.0.0.1');
    expect(() => loadConfig({ DASH_HOST: '0.0.0.0' })).toThrow(/DASH_HOST/);
  });

  it('loadConfig applies defaults and lists every invalid variable', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      dataDir: './.data',
      port: 8787,
      baseUrl: 'http://127.0.0.1:8787',
      env: 'development',
    });
    expect(c.configDir).toBe(join('./.data', 'config'));
    expect(c.secretKeyFile).toBe(join('./.data/config', 'secret.key'));
    expect(() => loadConfig({ DASH_PORT: 'abc', NODE_ENV: 'weird', DASH_HOST: '0.0.0.0' })).toThrow(
      /DASH_PORT[\s\S]*NODE_ENV[\s\S]*DASH_HOST/,
    );
  });

  it('unknown error → 500 with code internal and no stack', async () => {
    const app = await make();
    app.get('/api/boom', () => {
      throw new Error('secret detail /etc/passwd');
    });
    const res = await app.inject({ url: '/api/boom' });
    expect(res.statusCode).toBe(500);
    expect(errOf(res).error.code).toBe('internal');
    expect(res.body).not.toContain('secret detail');
    expect(res.body).not.toContain('    at ');
  });

  it("DashError('conflict') → 409", async () => {
    const app = await make();
    app.get('/api/c', () => {
      throw new DashError('conflict', 'version mismatch', { v: 2 });
    });
    const res = await app.inject({ url: '/api/c' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: { code: 'conflict', message: 'version mismatch', details: { v: 2 } },
    });
  });

  it('CSP header present on HTML and API', async () => {
    const app = await make();
    const csp =
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";
    for (const url of ['/api/health', '/', '/p/x', '/api/nope', '/assets/app-abc123.js']) {
      const res = await app.inject({ url });
      expect(res.headers['content-security-policy'], url).toBe(csp);
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['referrer-policy'], url).toBe('no-referrer');
      expect(res.headers['permissions-policy'], url).toBe('geolocation=(), camera=(), microphone=()');
    }
  });

  it('body over 1 MB → 413', async () => {
    const app = await make();
    app.post('/api/echo', (r) => r.body);
    const res = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ a: 'x'.repeat(1024 * 1024 + 10) }),
    });
    expect(res.statusCode).toBe(413);
    expect(errOf(res).error.code).toBe('invalid');
  });

  it('malformed JSON → 422 invalid', async () => {
    const app = await make();
    app.post('/api/echo', (r) => r.body);
    const res = await app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{bad',
    });
    expect(res.statusCode).toBe(422);
    expect(errOf(res).error.code).toBe('invalid');
  });

  it('unknown /api path → 404 ErrorDto, never the SPA fallback', async () => {
    const app = await make();
    for (const url of ['/api/x', '/api']) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(404);
      expect(errOf(res).error.code, url).toBe('not_found');
    }
  });

  it('SPA fallback serves index.html for /p/x but not /api/x, /dav/x, /.well-known/x', async () => {
    const app = await make();
    const spa = await app.inject({ url: '/p/x' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('<title>dash</title>');
    for (const url of ['/api/x', '/dav/x', '/.well-known/x']) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(404);
      expect(res.body, url).not.toContain('<title>dash</title>');
    }
  });

  it('cache headers: hashed assets immutable, index.html no-cache', async () => {
    const app = await make();
    const asset = await app.inject({ url: '/assets/app-abc123.js' });
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    for (const url of ['/', '/index.html', '/p/x']) {
      const res = await app.inject({ url });
      expect(res.headers['cache-control'], url).toBe('no-cache');
    }
  });

  it('missing web dist: app starts, non-API paths 404, health works', async () => {
    const app = await make(join(tmpdir(), 'dash-does-not-exist-xyz'));
    expect((await app.inject({ url: '/' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/p/x' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
  });
});
