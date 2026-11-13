import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSession, purgeExpiredSessions } from '../../src/auth/sessions.ts';
import { createUser } from '../../src/auth/users.ts';
import { makeAuthEnv, PASSWORD, type AuthEnv } from './env.ts';

let env: AuthEnv | undefined;
afterEach(async () => {
  await env?.app.close();
  env = undefined;
});

const DAY = 24 * 60 * 60 * 1000;
const json = { 'content-type': 'application/json' };

describe('login', () => {
  it('login sets cookie with HttpOnly, Secure, SameSite=Strict', async () => {
    env = await makeAuthEnv();
    await env.addUser('Alice');
    const { res } = await env.login('Alice');
    expect(res.statusCode).toBe(200);
    const raw = String(res.headers['set-cookie']);
    expect(raw).toMatch(/^dash_sid=[A-Za-z0-9_-]{43};/);
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Secure');
    expect(raw).toContain('SameSite=Strict');
    expect(raw).toContain('Path=/');
    expect(raw).toContain(`Max-Age=${180 * 24 * 3600}`);
  });

  it('wrong password → 401 same body as unknown user', async () => {
    env = await makeAuthEnv();
    await env.addUser('Alice');
    const wrong = await env.login('Alice', 'not the password!');
    const unknown = await env.login('Nobody', 'not the password!');
    expect(wrong.res.statusCode).toBe(401);
    expect(unknown.res.statusCode).toBe(401);
    expect(wrong.res.body).toBe(unknown.res.body);
    expect(wrong.res.headers['set-cookie']).toBeUndefined();
  });

  it('logout invalidates session', async () => {
    env = await makeAuthEnv();
    await env.addUser('Alice');
    const { cookie, csrf } = await env.login('Alice');
    const out = await env.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-csrf': csrf } });
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toContain('Max-Age=0');
    const me = await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('logout without X-CSRF → 403 and the session survives', async () => {
    env = await makeAuthEnv();
    await env.addUser('Alice');
    const { cookie } = await env.login('Alice');
    const out = await env.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(out.statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
  });

  it('expired session → 401', async () => {
    env = await makeAuthEnv();
    await env.addUser('Alice');
    const { cookie } = await env.login('Alice');
    env.clock.now = new Date(env.clock.now.getTime() + 31 * DAY);
    const me = await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('absolute expiry after 180 days even when active', async () => {
    env = await makeAuthEnv();
    await env.addUser('Alice');
    const { cookie } = await env.login('Alice');
    for (let day = 20; day < 180; day += 20) {
      env.clock.now = new Date(env.clock.now.getTime() + 20 * DAY);
      expect((await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(200);
    }
    env.clock.now = new Date(env.clock.now.getTime() + 21 * DAY); // 181 days after login, 21 idle days
    expect((await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('last_seen_at is not rewritten within a minute', async () => {
    env = await makeAuthEnv();
    await env.addUser('Alice');
    const { cookie } = await env.login('Alice');
    const seen = (): string =>
      (env!.db.prepare('SELECT last_seen_at AS t FROM sessions').get() as { t: string }).t;
    const first = seen();
    env.clock.now = new Date(env.clock.now.getTime() + 30_000);
    await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(seen()).toBe(first);
    env.clock.now = new Date(env.clock.now.getTime() + 31_000);
    await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(seen()).toBe(env.clock.now.toISOString());
  });

  it('disabled user cannot log in and existing sessions die', async () => {
    env = await makeAuthEnv();
    const alice = await env.addUser('Alice');
    const { cookie } = await env.login('Alice');
    const { disableUser } = await import('../../src/auth/users.ts');
    disableUser(env.deps, alice.id);
    expect((await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    const again = await env.login('Alice');
    expect(again.res.statusCode).toBe(401);
    // A session row that outlives the disable (e.g. written concurrently) is still treated as absent.
    const stray = createSession(env.db, alice.id, env.clock.now);
    const me = await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `dash_sid=${stray.sid}` } });
    expect(me.statusCode).toBe(401);
  });

  it('password shorter than 12 rejected', async () => {
    env = await makeAuthEnv();
    await expect(createUser(env.deps, { name: 'Bob', password: 'elevenchars', role: 'member' })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(createUser(env.deps, { name: 'Bob', password: 'x'.repeat(257), role: 'member' })).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
  });

  it('session id is not stored in clear', async () => {
    env = await makeAuthEnv();
    await env.addUser('Alice');
    const { cookie } = await env.login('Alice');
    const sid = cookie.slice('dash_sid='.length);
    const row = env.db.prepare('SELECT * FROM sessions').get() as Record<string, string>;
    expect(row['id_hash']).toBe(createHash('sha256').update(sid).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(sid);
  });

  it('login requires application/json and is exempt from CSRF', async () => {
    env = await makeAuthEnv();
    await env.addUser('Alice');
    const res = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ name: 'Alice', password: PASSWORD }),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('a 21st session evicts the oldest', async () => {
    env = await makeAuthEnv();
    const alice = await env.addUser('Alice');
    const sids: string[] = [];
    for (let i = 0; i < 21; i++) {
      env.clock.now = new Date(env.clock.now.getTime() + 1000);
      sids.push(createSession(env.db, alice.id, env.clock.now).sid);
    }
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 20 });
    const status = async (sid: string): Promise<number> =>
      (await env!.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: `dash_sid=${sid}` } })).statusCode;
    expect(await status(sids[0] as string)).toBe(401);
    expect(await status(sids[1] as string)).toBe(200);
    expect(await status(sids[20] as string)).toBe(200);
  });

  it('purgeExpiredSessions removes expired rows', async () => {
    env = await makeAuthEnv();
    const alice = await env.addUser('Alice');
    createSession(env.db, alice.id, env.clock.now);
    expect(purgeExpiredSessions(env.db, new Date(env.clock.now.getTime() + DAY))).toBe(0);
    expect(purgeExpiredSessions(env.db, new Date(env.clock.now.getTime() + 31 * DAY))).toBe(1);
  });
});

describe('me and prefs', () => {
  it('GET /api/me returns the session csrf and never password_hash', async () => {
    env = await makeAuthEnv({ modules: [{ id: 'weather', levels: ['view'] }] });
    await env.addUser('Alice', 'admin');
    const { res, cookie, csrf } = await env.login('Alice');
    expect(res.json()).toMatchObject({ name: 'Alice', handle: 'alice', role: 'admin', grants: { weather: 'edit' } });
    const me = await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.json<{ csrf: string }>().csrf).toBe(csrf);
    expect(me.json()).toMatchObject({ prefs: { theme: 'default', modePolicy: 'system', locale: 'en', timeZone: 'UTC' } });
    expect(me.body).not.toMatch(/password|argon2|totp/i);
    expect(res.body).not.toMatch(/password|argon2|totp/i);
  });

  it('GET /api/me without a session → 401', async () => {
    env = await makeAuthEnv();
    expect((await env.app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
  });

  it('PATCH /api/me/prefs merges, requires X-CSRF and validates the time zone', async () => {
    env = await makeAuthEnv();
    await env.addUser('Alice');
    const { cookie, csrf } = await env.login('Alice');
    const patch = (headers: Record<string, string>, payload: object) =>
      env!.app.inject({ method: 'PATCH', url: '/api/me/prefs', headers: { cookie, ...json, ...headers }, payload });

    expect((await patch({}, { theme: 'dark-forest' })).statusCode).toBe(403);
    expect((await patch({ 'x-csrf': csrf }, { timeZone: 'Mars/Olympus' })).statusCode).toBe(422);
    expect((await patch({ 'x-csrf': csrf }, { theme: 'Not Valid' })).statusCode).toBe(422);
    expect((await patch({ 'x-csrf': csrf }, { modePolicy: 'always' })).statusCode).toBe(422);
    expect((await patch({ 'x-csrf': csrf }, { locale: 'x'.repeat(11) })).statusCode).toBe(422);

    const ok = await patch({ 'x-csrf': csrf }, { theme: 'dark-forest', timeZone: 'Europe/Berlin' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ prefs: { theme: 'dark-forest', modePolicy: 'system', locale: 'en', timeZone: 'Europe/Berlin' } });
    const me = await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ prefs: { theme: 'dark-forest', timeZone: 'Europe/Berlin' } });
  });

  it('request.session.csrf is visible to a route registered outside the plugin', async () => {
    env = await makeAuthEnv();
    env.app.get('/outside', (req) => ({ csrf: req.session?.csrf ?? null, user: req.user?.handle ?? null }));
    await env.addUser('Alice');
    const { cookie, csrf } = await env.login('Alice');
    const res = await env.app.inject({ method: 'GET', url: '/outside', headers: { cookie } });
    expect(res.json()).toEqual({ csrf, user: 'alice' });
    const anon = await env.app.inject({ method: 'GET', url: '/outside' });
    expect(anon.json()).toEqual({ csrf: null, user: null });
  });
});

describe('createUser', () => {
  it('duplicate name differing only in case → 409', async () => {
    env = await makeAuthEnv();
    await env.addUser('Alice');
    await expect(createUser(env.deps, { name: 'ALICE', password: PASSWORD, role: 'member' })).rejects.toMatchObject({
      code: 'conflict',
    });
    // handle collision through whitespace removal
    await expect(createUser(env.deps, { name: 'Al ice', password: PASSWORD, role: 'member' })).rejects.toMatchObject({
      code: 'conflict',
    });
  });

  it('derives the handle, rejects bad handles, creates the starter page and audits', async () => {
    env = await makeAuthEnv();
    const created: string[] = [];
    const deps = { ...env.deps, onUserCreated: (id: string) => created.push(id) };
    const u = await createUser(deps, { name: 'Mary Jane', password: PASSWORD, role: 'member' });
    expect(u.handle).toBe('maryjane');
    expect(created).toEqual([u.id]);
    await expect(createUser(deps, { name: 'Jörg', password: PASSWORD, role: 'member' })).rejects.toMatchObject({
      code: 'invalid',
    });
    const audit = env.db.prepare("SELECT user_id, detail FROM audit_log WHERE action = 'user.create'").all();
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
  });

  it('audits login success, failure (truncated name, no password) and logout', async () => {
    env = await makeAuthEnv();
    await env.addUser('Alice');
    const long = 'n'.repeat(100);
    await env.login(long, 'secret-attempt-123');
    const { cookie, csrf } = await env.login('Alice');
    await env.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-csrf': csrf } });
    const rows = env.db
      .prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'auth.%' ORDER BY id")
      .all() as Array<{ action: string; detail: string | null }>;
    expect(rows.map((r) => r.action)).toEqual(['auth.login.failure', 'auth.login.success', 'auth.logout']);
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({ name: 'n'.repeat(64) });
    expect(JSON.stringify(rows)).not.toContain('secret-attempt-123');
  });
});
