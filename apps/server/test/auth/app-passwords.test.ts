import { verifySync } from '@node-rs/argon2';
import { afterEach, describe, expect, it } from 'vitest';
import { makeAuthEnv, type AuthEnv } from './env.ts';

let env: AuthEnv | undefined;
afterEach(async () => {
  await env?.app.close();
  env = undefined;
});

const json = { 'content-type': 'application/json' };
const basic = (name: string, pw: string): string => `Basic ${Buffer.from(`${name}:${pw}`).toString('base64')}`;
type Session = { cookie: string; csrf: string };

async function create(e: AuthEnv, s: Session, label = 'phone') {
  return e.app.inject({ method: 'POST', url: '/api/me/app-passwords', headers: { cookie: s.cookie, 'x-csrf': s.csrf, ...json }, payload: { label } });
}

async function setup() {
  const counter = { n: 0 };
  env = await makeAuthEnv({
    auth: {
      verifyAppPasswordHash: (h, p) => {
        counter.n += 1;
        return verifySync(h, p);
      },
    },
  });
  const user = await env.addUser('Alice');
  const s = await env.login('Alice');
  const res = await create(env, s);
  expect(res.statusCode).toBe(201);
  const { id, password } = res.json<{ id: string; password: string }>();
  return { e: env, user, s, id, password, counter };
}

describe('app passwords', () => {
  it('shows the password once in groups of four and never in the list', async () => {
    const { e, s, password, id } = await setup();
    expect(password).toMatch(/^([A-Z2-7]{4}-){5}[A-Z2-7]{4}$/);
    const list = await e.app.inject({ method: 'GET', url: '/api/me/app-passwords', headers: { cookie: s.cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(password.replaceAll('-', ''));
    expect(list.body).not.toContain(password.slice(0, 4));
    expect(list.json()).toEqual([{ id, label: 'phone', scope: 'caldav', createdAt: e.clock.now.toISOString(), lastUsedAt: null }]);
    const stored = e.db.prepare('SELECT hash, selector, scope FROM app_passwords').get() as { hash: string; selector: string; scope: string };
    expect(stored.hash).toMatch(/^\$argon2id\$/);
    expect(stored.selector).toBe(password.replaceAll('-', '').slice(0, 8));
    expect(stored.scope).toBe('caldav');
    const audit = e.db.prepare("SELECT detail FROM audit_log WHERE action = 'auth.app_password.create'").get() as { detail: string };
    expect(audit.detail).toContain('phone');
    expect(audit.detail).not.toContain(password.slice(0, 4));
  });

  it('validates the label and caps at 10 per user (11th is 409)', async () => {
    const { e, s } = await setup();
    expect((await create(e, s, '')).statusCode).toBe(422);
    expect((await create(e, s, 'x'.repeat(61))).statusCode).toBe(422);
    for (let i = 1; i < 10; i++) expect((await create(e, s, `d${i}`)).statusCode).toBe(201);
    expect((await create(e, s, 'eleventh')).statusCode).toBe(409);
  });

  it('app password verifies via Basic header and updates last_used_at', async () => {
    const { e, user, password, id } = await setup();
    const got = e.auth.verifyAppPassword(basic('Alice', password));
    expect(got).toEqual({ id: user.id, name: 'Alice', handle: 'alice', role: 'member' });
    const row = () => e.db.prepare('SELECT last_used_at AS t FROM app_passwords WHERE id = ?').get(id) as { t: string | null };
    expect(row().t).toBe(e.clock.now.toISOString());
    const first = e.clock.now;
    e.clock.now = new Date(first.getTime() + 30_000);
    e.auth.verifyAppPassword(basic('Alice', password));
    expect(row().t).toBe(first.toISOString()); // at most once a minute
    e.clock.now = new Date(first.getTime() + 61_000);
    e.auth.verifyAppPassword(basic('Alice', password));
    expect(row().t).toBe(e.clock.now.toISOString());
  });

  it('accepts the password with or without separators and in lower case; rejects malformed input', async () => {
    const { e, password } = await setup();
    const bare = password.replaceAll('-', '');
    expect(e.auth.verifyAppPassword(basic('Alice', bare))).not.toBeNull();
    expect(e.auth.verifyAppPassword(basic('alice', bare.toLowerCase()))).not.toBeNull();
    expect(e.auth.verifyAppPassword(basic('Alice', password.toLowerCase()))).not.toBeNull();
    expect(e.auth.verifyAppPassword(basic('Alice', `${bare.slice(0, 23)}A`))).toBeNull();
    expect(e.auth.verifyAppPassword(basic('Nobody', bare))).toBeNull();
    expect(e.auth.verifyAppPassword(basic('Alice', 'short'))).toBeNull();
    expect(e.auth.verifyAppPassword(undefined)).toBeNull();
    expect(e.auth.verifyAppPassword('Bearer abc')).toBeNull();
    expect(e.auth.verifyAppPassword('Basic !!!')).toBeNull();
    expect(e.auth.verifyAppPassword(`Basic ${Buffer.from('nocolon').toString('base64')}`)).toBeNull();
  });

  it('second verification within 10 minutes does not call argon2; after 10 minutes it does', async () => {
    const { e, password, counter } = await setup();
    expect(e.auth.verifyAppPassword(basic('Alice', password))).not.toBeNull();
    const after1 = counter.n;
    expect(after1).toBe(1);
    e.clock.now = new Date(e.clock.now.getTime() + 9 * 60_000);
    expect(e.auth.verifyAppPassword(basic('Alice', password))).not.toBeNull();
    expect(counter.n).toBe(after1);
    e.clock.now = new Date(e.clock.now.getTime() + 2 * 60_000);
    expect(e.auth.verifyAppPassword(basic('Alice', password))).not.toBeNull();
    expect(counter.n).toBe(after1 + 1);
  });

  it('deleted app password stops working, even from the cache', async () => {
    const { e, s, id, password } = await setup();
    expect(e.auth.verifyAppPassword(basic('Alice', password))).not.toBeNull();
    const del = await e.app.inject({ method: 'DELETE', url: `/api/me/app-passwords/${id}`, headers: { cookie: s.cookie, 'x-csrf': s.csrf } });
    expect(del.statusCode).toBe(204);
    expect(e.auth.verifyAppPassword(basic('Alice', password))).toBeNull();
    expect(e.db.prepare("SELECT 1 FROM audit_log WHERE action = 'auth.app_password.delete'").get()).toBeTruthy();
  });

  it('an app password of another user cannot be deleted (404)', async () => {
    const { e, id, password } = await setup();
    await e.addUser('Bob');
    const bob = await e.login('Bob');
    const del = await e.app.inject({ method: 'DELETE', url: `/api/me/app-passwords/${id}`, headers: { cookie: bob.cookie, 'x-csrf': bob.csrf } });
    expect(del.statusCode).toBe(404);
    expect(e.auth.verifyAppPassword(basic('Alice', password))).not.toBeNull();
    // Alice's password does not work under Bob's name.
    expect(e.auth.verifyAppPassword(basic('Bob', password))).toBeNull();
  });

  it('a disabled user\'s app password stops working immediately (also when cached)', async () => {
    const { e, user, password } = await setup();
    expect(e.auth.verifyAppPassword(basic('Alice', password))).not.toBeNull();
    await e.addUser('Root', 'admin');
    const root = await e.login('Root');
    const res = await e.app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${user.id}`,
      headers: { cookie: root.cookie, 'x-csrf': root.csrf, ...json },
      payload: { disabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(e.auth.verifyAppPassword(basic('Alice', password))).toBeNull();
  });

  it('app password rejected on /api/me', async () => {
    const { e, password } = await setup();
    const res = await e.app.inject({ method: 'GET', url: '/api/me', headers: { authorization: basic('Alice', password) } });
    expect(res.statusCode).toBe(401);
    const list = await e.app.inject({ method: 'GET', url: '/api/me/app-passwords', headers: { authorization: basic('Alice', password) } });
    expect(list.statusCode).toBe(401);
  });

  it('failed attempts lock the name; a locked name returns null without verifying', async () => {
    const { e, password, counter } = await setup();
    const wrong = `${password.replaceAll('-', '').slice(0, 8)}${'A'.repeat(16)}`;
    for (let i = 0; i < 5; i++) expect(e.auth.verifyAppPassword(basic('Alice', wrong))).toBeNull();
    const before = counter.n;
    expect(e.auth.verifyAppPassword(basic('Alice', password))).toBeNull();
    expect(counter.n).toBe(before);
    e.clock.now = new Date(e.clock.now.getTime() + 16 * 60_000);
    expect(e.auth.verifyAppPassword(basic('Alice', password))).not.toBeNull();
  });
});
