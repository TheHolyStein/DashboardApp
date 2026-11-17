import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUser } from '../../src/auth/users.ts';
import { createAudit } from '../../src/core/audit.ts';
import { lanHostsOf } from '../../src/core/compose.ts';
import { start, type Started } from '../../src/main.ts';
import { serverFor } from './module-env.ts';

const PASSWORD = 'correct horse battery';
const started: Started[] = [];
afterEach(async () => {
  while (started.length) await started.pop()!.close();
});

function envFor(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'dash-wiring-'));
  return {
    NODE_ENV: 'test',
    DASH_DATA_DIR: join(root, 'data'),
    DASH_CONFIG_DIR: join(root, 'config'),
    DASH_PORT: '0',
    ...extra,
  };
}

async function boot(extra: Record<string, string> = {}): Promise<Started> {
  const s = await start(envFor(extra), { logger: false });
  started.push(s);
  return s;
}

describe('start()', () => {
  it('serves health, signs in, lists the starter page, and closes cleanly', async () => {
    const s = await boot();
    const health = await fetch(`${s.address}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, contract: 2 });

    const now = (): Date => new Date();
    await createUser(
      { db: s.db, audit: createAudit(s.db, now), now, applyChange: (id, m) => s.services.auth.applyUserChange(id, m) },
      { name: 'Admin', password: PASSWORD, role: 'admin' },
    );

    const denied = await fetch(`${s.address}/api/me`);
    expect(denied.status).toBe(401);
    const login = await fetch(`${s.address}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Admin', password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).not.toBe('');

    const me = await fetch(`${s.address}/api/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ name: 'Admin', role: 'admin' });

    const pages = await fetch(`${s.address}/api/pages`, { headers: { cookie } });
    expect(pages.status).toBe(200);
    const body: unknown = await pages.json();
    expect(JSON.stringify(body)).toContain('Today');

    await s.close();
    await s.close(); // idempotent
    await expect(fetch(`${s.address}/api/health`)).rejects.toThrow();
  });

  it('production without a secret key file refuses to start and names the path', async () => {
    const env = envFor({ NODE_ENV: 'production' });
    const keyFile = join(env['DASH_CONFIG_DIR'] as string, 'secret.key');
    await expect(start(env, { logger: false })).rejects.toThrow(keyFile);
  });

  it('production with a key file that is group/world readable refuses to start', async () => {
    const env = envFor({ NODE_ENV: 'production' });
    const keyFile = join(mkdtempSync(join(tmpdir(), 'dash-key-')), 'secret.key');
    writeFileSync(keyFile, Buffer.alloc(32, 7), { mode: 0o666 });
    await expect(start({ ...env, DASH_SECRET_KEY_FILE: keyFile }, { logger: false })).rejects.toThrow(keyFile);
  });
});

describe('lanHosts convention', () => {
  it('reads the string array at key lanHosts of the module config, else empty', async () => {
    const s = await boot();
    s.db.prepare("INSERT INTO module_state (module_id, config) VALUES ('wled', ?)").run(JSON.stringify({ lanHosts: ['10.0.0.5', 'x:80', 3] }));
    s.db.prepare("INSERT INTO module_state (module_id, config) VALUES ('nas', ?)").run('{"other":1}');
    expect(lanHostsOf(s.db, 'wled')).toEqual(['10.0.0.5', 'x:80']);
    expect(lanHostsOf(s.db, 'nas')).toEqual([]);
    expect(lanHostsOf(s.db, 'missing')).toEqual([]);
  });
});

describe('module runtime services', () => {
  it('a module gets real store, secrets, snapshots and a routed, permission-checked API', async () => {
    const demo = serverFor('demo', (r, host) => {
      r.post('/ping', { level: 'edit' }, async () => {
        await host.store.set('n', 41);
        await host.secrets.set('token', 'abc');
        host.push(null, { hello: 'world' });
        return { n: ((await host.store.get<number>('n')) ?? 0) + 1, token: await host.secrets.get('token') };
      });
    });
    const s = await start(envFor(), { logger: false, registry: [() => Promise.resolve({ default: demo })] });
    started.push(s);
    expect(s.services.modules.map((m) => [m.id, m.failed])).toEqual([['demo', undefined]]);
    const now = (): Date => new Date();
    await createUser(
      { db: s.db, audit: createAudit(s.db, now), now, applyChange: (id, m) => s.services.auth.applyUserChange(id, m) },
      { name: 'Admin', password: PASSWORD, role: 'admin' },
    );
    const login = await fetch(`${s.address}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Admin', password: PASSWORD }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const csrf = ((await login.json()) as { csrf: string }).csrf;
    const res = await fetch(`${s.address}/api/m/demo/ping`, { method: 'POST', headers: { cookie, 'x-csrf': csrf } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ n: 42, token: 'abc' });
    expect(s.services.snapshots.get('demo', null)?.data).toEqual({ hello: 'world' });
  });
});
