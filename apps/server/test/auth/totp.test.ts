import * as OTPAuth from 'otpauth';
import { afterEach, describe, expect, it } from 'vitest';
import { makeAuthEnv, PASSWORD, type AuthEnv } from './env.ts';

let env: AuthEnv | undefined;
afterEach(async () => {
  await env?.app.close();
  env = undefined;
});

const json = { 'content-type': 'application/json' };

function code(secret: string, at: Date): string {
  return new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate({
    timestamp: at.getTime(),
  });
}

async function attempt(e: AuthEnv, body: object, remoteAddress?: string) {
  return e.app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: json,
    payload: body,
    ...(remoteAddress ? { remoteAddress } : {}),
  });
}

async function post(e: AuthEnv, s: { cookie: string; csrf: string }, url: string, payload: object) {
  return e.app.inject({ method: 'POST', url, headers: { cookie: s.cookie, 'x-csrf': s.csrf, ...json }, payload });
}

/** Alice with setup (not enabled). */
async function withSetup() {
  env = await makeAuthEnv();
  const alice = await env.addUser('Alice');
  const s = await env.login('Alice');
  const setup = await post(env, s, '/api/me/totp/setup', {});
  expect(setup.statusCode).toBe(200);
  const { secret, otpauthUrl } = setup.json<{ secret: string; otpauthUrl: string }>();
  return { e: env, alice, s, secret, otpauthUrl };
}

async function enabled() {
  const ctx = await withSetup();
  const en = await post(ctx.e, ctx.s, '/api/me/totp/enable', { code: code(ctx.secret, ctx.e.clock.now) });
  expect(en.statusCode).toBe(204);
  return ctx;
}

describe('totp', () => {
  it('setup returns a 160-bit base32 secret and an otpauth URL with issuer, label and parameters', async () => {
    const { secret, otpauthUrl } = await withSetup();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const u = new URL(otpauthUrl);
    expect(u.protocol).toBe('otpauth:');
    expect(u.searchParams.get('issuer')).toBe('Dashboard');
    expect(u.searchParams.get('algorithm')).toBe('SHA1');
    expect(u.searchParams.get('digits')).toBe('6');
    expect(u.searchParams.get('period')).toBe('30');
    expect(u.pathname).toContain('Alice');
  });

  it('GET /api/me reports totpEnabled: false when none or pending, true when enabled or unreadable', async () => {
    const meOf = async (e: AuthEnv, cookie: string) =>
      (await e.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json<{ totpEnabled: boolean }>().totpEnabled;
    const pending = await withSetup();
    expect(await meOf(pending.e, pending.s.cookie)).toBe(false);
    await env?.app.close();
    const ctx = await enabled();
    expect(await meOf(ctx.e, ctx.s.cookie)).toBe(true);
    ctx.e.db.prepare('UPDATE users SET totp_secret_enc = ? WHERE id = ?').run('garbage', ctx.alice.id);
    expect(await meOf(ctx.e, ctx.s.cookie)).toBe(true);
    expect((await post(ctx.e, ctx.s, '/api/me/totp/disable', { password: PASSWORD })).statusCode).toBe(204);
    expect(await meOf(ctx.e, ctx.s.cookie)).toBe(false);
  });

  it('totp_secret_enc in the database is not the base32 secret', async () => {
    const { e, alice, secret } = await enabled();
    const stored = (e.db.prepare('SELECT totp_secret_enc AS v FROM users WHERE id = ?').get(alice.id) as { v: string }).v;
    expect(stored).not.toContain(secret);
    expect(Buffer.from(stored, 'base64').toString('latin1')).not.toContain(secret);
    expect(Buffer.from(stored, 'base64').length).toBeGreaterThan(12 + 16 + secret.length);
  });

  it('TOTP setup without enable does not require a code at login', async () => {
    const { e } = await withSetup();
    expect((await e.login('Alice')).res.statusCode).toBe(200);
  });

  it('enable rejects a wrong code and needs a pending setup', async () => {
    const { e, s, secret } = await withSetup();
    const bad = await post(e, s, '/api/me/totp/enable', { code: code(secret, new Date(e.clock.now.getTime() + 600_000)) });
    expect(bad.statusCode).toBe(422);
    expect((await post(e, s, '/api/me/totp/enable', { code: code(secret, e.clock.now) })).statusCode).toBe(204);
    expect((await post(e, s, '/api/me/totp/setup', {})).statusCode).toBe(409);
  });

  it('login with TOTP enabled requires code', async () => {
    const { e, secret } = await enabled();
    e.clock.now = new Date(e.clock.now.getTime() + 60_000); // past the step used for enabling
    const missing = await attempt(e, { name: 'Alice', password: PASSWORD });
    expect(missing.statusCode).toBe(422);
    expect(missing.json<{ error: { code: string; details: { totpRequired: boolean } } }>().error.details.totpRequired).toBe(true);
    expect(missing.headers['set-cookie']).toBeUndefined();
    const ok = await attempt(e, { name: 'Alice', password: PASSWORD, totp: code(secret, e.clock.now) });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['set-cookie']).toBeDefined();
  });

  it('missing code answers 422 totpRequired without costing a rate-limit attempt', async () => {
    const { e } = await enabled();
    for (let i = 0; i < 6; i++) {
      const r = await attempt(e, { name: 'Alice', password: PASSWORD }, '10.1.1.1');
      expect(r.statusCode).toBe(422);
    }
    expect(e.db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE locked_until IS NOT NULL").get()).toEqual({ n: 0 });
    expect(e.db.prepare("SELECT COALESCE(SUM(count), 0) AS n FROM login_attempts").get()).toEqual({ n: 0 });
  });

  it('wrong code is a plain 401 and counts as a failure', async () => {
    const { e, secret } = await enabled();
    e.clock.now = new Date(e.clock.now.getTime() + 60_000);
    const good = code(secret, e.clock.now);
    const wrong = good === '000000' ? '111111' : '000000';
    const r = await attempt(e, { name: 'Alice', password: PASSWORD, totp: wrong }, '10.2.2.2');
    expect(r.statusCode).toBe(401);
    expect(r.json<{ error: { details?: unknown } }>().error.details).toBeUndefined();
    expect(e.db.prepare("SELECT count FROM login_attempts WHERE key = 'user:alice'").get()).toEqual({ count: 1 });
    for (let i = 0; i < 4; i++) await attempt(e, { name: 'Alice', password: PASSWORD, totp: wrong }, '10.2.2.2');
    const locked = await attempt(e, { name: 'Alice', password: PASSWORD, totp: good }, '10.2.2.2');
    expect(locked.statusCode).toBe(429);
  });

  it('wrong password for a TOTP user is a plain 401 without totpRequired, same body as unknown user', async () => {
    const { e } = await enabled();
    const wrong = await attempt(e, { name: 'Alice', password: 'not the password!' });
    const unknown = await attempt(e, { name: 'Nobody', password: 'not the password!' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).toBe(unknown.body);
    expect(wrong.body).not.toContain('totpRequired');
  });

  it('replayed code rejected', async () => {
    const { e, secret } = await enabled();
    e.clock.now = new Date(e.clock.now.getTime() + 60_000);
    const c = code(secret, e.clock.now);
    expect((await attempt(e, { name: 'Alice', password: PASSWORD, totp: c })).statusCode).toBe(200);
    expect((await attempt(e, { name: 'Alice', password: PASSWORD, totp: c })).statusCode).toBe(401);
  });

  it('a code from the previous step is accepted once, then rejected; the code used at enable cannot log in', async () => {
    const { e, secret } = await enabled();
    const enableCode = code(secret, e.clock.now);
    expect((await attempt(e, { name: 'Alice', password: PASSWORD, totp: enableCode })).statusCode).toBe(401);
    e.clock.now = new Date(e.clock.now.getTime() + 60_000);
    const prev = code(secret, new Date(e.clock.now.getTime() - 30_000));
    expect((await attempt(e, { name: 'Alice', password: PASSWORD, totp: prev })).statusCode).toBe(200);
    expect((await attempt(e, { name: 'Alice', password: PASSWORD, totp: prev })).statusCode).toBe(401);
    const old = code(secret, new Date(e.clock.now.getTime() - 90_000));
    expect((await attempt(e, { name: 'Alice', password: PASSWORD, totp: old })).statusCode).toBe(401);
  });

  it('disabling TOTP needs the correct password; afterwards no code is needed', async () => {
    const { e, s } = await enabled();
    const wrongPw = await post(e, s, '/api/me/totp/disable', { password: 'not the password!' });
    expect(wrongPw.statusCode).toBe(403);
    expect(wrongPw.json<{ error: { details: unknown } }>().error.details).toEqual({ reason: 'wrong_password' });
    expect((await attempt(e, { name: 'Alice', password: PASSWORD })).statusCode).toBe(422);
    expect((await post(e, s, '/api/me/totp/disable', { password: PASSWORD })).statusCode).toBe(204);
    expect((await e.login('Alice')).res.statusCode).toBe(200);
    expect(e.db.prepare('SELECT totp_secret_enc AS v FROM users').get()).toEqual({ v: null });
  });

  it('an admin can reset another user\'s TOTP; audit entries exist and hold no secrets', async () => {
    const { e, alice, secret } = await enabled();
    await e.addUser('Root', 'admin');
    const root = await e.login('Root');
    const list = await e.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: root.cookie } });
    expect(list.json<Array<{ name: string; totpEnabled: boolean }>>().find((u) => u.name === 'Alice')?.totpEnabled).toBe(true);
    const res = await e.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${alice.id}`,
      headers: { cookie: root.cookie, 'x-csrf': root.csrf, ...json },
      payload: { resetTotp: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ totpEnabled: boolean }>().totpEnabled).toBe(false);
    expect((await e.login('Alice')).res.statusCode).toBe(200);
    const actions = (e.db.prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'auth.totp.%'").all() as Array<{ action: string; detail: string | null }>);
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(['auth.totp.enable', 'auth.totp.reset']));
    expect(JSON.stringify(actions)).not.toContain(secret);
  });

  describe('unreadable stored secret fails closed', () => {
    const scramble = (e: AuthEnv, id: string): void => {
      e.db.prepare('UPDATE users SET totp_secret_enc = ? WHERE id = ?').run(Buffer.alloc(64, 7).toString('base64'), id);
    };

    it('scrambled ciphertext: correct password never yields a session, with or without a totp field', async () => {
      const { e, alice, secret } = await enabled();
      scramble(e, alice.id);
      e.clock.now = new Date(e.clock.now.getTime() + 60_000);
      const without = await attempt(e, { name: 'Alice', password: PASSWORD });
      expect(without.statusCode).toBe(401);
      expect(without.headers['set-cookie']).toBeUndefined();
      expect(without.body).not.toContain('totpRequired');
      const withCode = await attempt(e, { name: 'Alice', password: PASSWORD, totp: code(secret, e.clock.now) });
      expect(withCode.statusCode).toBe(401);
      expect(withCode.headers['set-cookie']).toBeUndefined();
      expect(e.db.prepare("SELECT user_id FROM audit_log WHERE action = 'auth.totp.unreadable'").get()).toEqual({ user_id: alice.id });
      expect(e.db.prepare("SELECT count FROM login_attempts WHERE key = 'user:alice'").get()).toEqual({ count: 2 });
    });

    it('a different server key on a fresh createAuth over the same database also refuses', async () => {
      const { e, secret } = await enabled();
      const { createAuth } = await import('../../src/auth/index.ts');
      const { buildApp } = await import('../../src/core/app.ts');
      const { createAudit } = await import('../../src/core/audit.ts');
      const { mkdtempSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { loadConfig } = await import('../../src/core/config.ts');
      const now = (): Date => e.clock.now;
      const config = loadConfig({ NODE_ENV: 'test' });
      const auth2 = createAuth({ db: e.db, audit: createAudit(e.db, now), config }, { now, secretKey: Buffer.alloc(32, 9) });
      const app2 = await buildApp({ config, db: e.db, auth: auth2, modules: [], webDistDir: mkdtempSync(join(tmpdir(), 'dash-auth-web-')), logger: false });
      try {
        const r = await app2.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: json,
          payload: { name: 'Alice', password: PASSWORD, totp: code(secret, e.clock.now) },
        });
        expect(r.statusCode).toBe(401);
        expect(r.headers['set-cookie']).toBeUndefined();
      } finally {
        await app2.close();
      }
    });

    it('admin list shows totpEnabled true; setup/enable are 409; reset lets the password alone sign in', async () => {
      const { e, alice, s } = await enabled();
      scramble(e, alice.id);
      await e.addUser('Root', 'admin');
      const root = await e.login('Root');
      const list = await e.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: root.cookie } });
      expect(list.json<Array<{ name: string; totpEnabled: boolean }>>().find((u) => u.name === 'Alice')?.totpEnabled).toBe(true);
      expect((await post(e, s, '/api/me/totp/setup', {})).statusCode).toBe(409);
      expect((await post(e, s, '/api/me/totp/enable', { code: '123456' })).statusCode).toBe(409);
      const reset = await e.app.inject({
        method: 'PATCH',
        url: `/api/admin/users/${alice.id}`,
        headers: { cookie: root.cookie, 'x-csrf': root.csrf, ...json },
        payload: { resetTotp: true },
      });
      expect(reset.statusCode).toBe(200);
      expect((await e.login('Alice')).res.statusCode).toBe(200);
    });

    it('disable with the correct password removes an unreadable value', async () => {
      const { e, alice, s } = await enabled();
      scramble(e, alice.id);
      expect((await post(e, s, '/api/me/totp/disable', { password: PASSWORD })).statusCode).toBe(204);
      expect((await e.login('Alice')).res.statusCode).toBe(200);
    });
  });
});
