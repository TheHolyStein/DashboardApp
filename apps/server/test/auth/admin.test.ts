import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeAuthEnv, PASSWORD, type AuthEnv } from './env.ts';

let env: AuthEnv | undefined;
afterEach(async () => {
  await env?.app.close();
  env = undefined;
});

const MODS = [{ id: 'notes', levels: ['view', 'edit'] as const }];
type Session = { cookie: string; csrf: string };
const h = (s: Session): Record<string, string> => ({ cookie: s.cookie, 'x-csrf': s.csrf });

async function call(
  e: AuthEnv,
  s: Session | null,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  headers?: Record<string, string>,
) {
  return e.app.inject({ method, url, headers: headers ?? (s ? h(s) : {}), ...(payload ? { payload } : {}) });
}

async function adminEnv() {
  env = await makeAuthEnv({ modules: [...MODS] });
  const admin = await env.addUser('Root', 'admin');
  const s = await env.login('Root');
  return { e: env, admin, s };
}

describe('admin users', () => {
  it('lists users without hashes or secrets and rejects members and missing CSRF with 403', async () => {
    const { e, s } = await adminEnv();
    await e.addUser('Mia');
    const list = await call(e, s, 'GET', '/api/admin/users');
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain('password_hash');
    expect(list.body).not.toContain('totp_secret_enc');
    expect(list.body).not.toContain('argon2');
    const rows = list.json<Array<Record<string, unknown>>>();
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['createdAt', 'disabled', 'handle', 'id', 'name', 'role', 'totpEnabled']);
    const member = await e.login('Mia');
    expect((await call(e, member, 'GET', '/api/admin/users')).statusCode).toBe(403);
    expect((await call(e, member, 'POST', '/api/admin/users', { name: 'X', password: PASSWORD, role: 'member' })).statusCode).toBe(403);
    const noCsrf = await call(e, null, 'POST', '/api/admin/users', { name: 'Zed', password: PASSWORD, role: 'member' }, { cookie: s.cookie });
    expect(noCsrf.statusCode).toBe(403);
    expect((await call(e, null, 'GET', '/api/admin/users')).statusCode).toBe(401);
  });

  it('creates users through the API (starter hook fires, audit has the actor) and validates', async () => {
    const created: string[] = [];
    env = await makeAuthEnv({ auth: { hooks: { onUserCreated: (id) => created.push(id) } } });
    const admin = await env.addUser('Root', 'admin');
    const s = await env.login('Root');
    const res = await call(env, s, 'POST', '/api/admin/users', { name: 'New Person', password: PASSWORD, role: 'member' });
    expect(res.statusCode).toBe(201);
    const dto = res.json<{ id: string; handle: string; totpEnabled: boolean }>();
    expect(dto.handle).toBe('newperson');
    expect(created).toEqual([dto.id]);
    expect((await call(env, s, 'POST', '/api/admin/users', { name: 'new person', password: PASSWORD, role: 'member' })).statusCode).toBe(409);
    expect((await call(env, s, 'POST', '/api/admin/users', { name: 'Short', password: 'short', role: 'member' })).statusCode).toBe(422);
    expect((await call(env, s, 'POST', '/api/admin/users', { name: 'Short', role: 'member' })).statusCode).toBe(422);
    const audit = env.db.prepare("SELECT user_id, detail, ip FROM audit_log WHERE action = 'user.create' AND detail LIKE '%New Person%'").get() as {
      user_id: string;
      detail: string;
      ip: string;
    };
    expect(audit.user_id).toBe(admin.id);
    expect(audit.detail).not.toContain(PASSWORD);
    expect(audit.ip).toBeTruthy();
  });

  it('patches name (new handle, uniqueness), role and disabled; disabling and password reset end sessions', async () => {
    const { e, s } = await adminEnv();
    const mia = await e.addUser('Mia');
    const miaS = await e.login('Mia');
    await e.addUser('Bob');
    const renamed = await call(e, s, 'PATCH', `/api/admin/users/${mia.id}`, { name: 'Mia Maria' });
    expect(renamed.json<{ handle: string }>().handle).toBe('miamaria');
    expect((await call(e, s, 'PATCH', `/api/admin/users/${mia.id}`, { name: 'bob' })).statusCode).toBe(409);
    expect((await call(e, s, 'PATCH', `/api/admin/users/${mia.id}`, { name: '!!!' })).statusCode).toBe(422);
    expect((await call(e, s, 'PATCH', `/api/admin/users/${mia.id}`, {})).statusCode).toBe(422);
    expect((await call(e, s, 'PATCH', '/api/admin/users/nope', { name: 'Q' })).statusCode).toBe(404);
    const dis = await call(e, s, 'PATCH', `/api/admin/users/${mia.id}`, { disabled: true });
    expect(dis.json<{ disabled: boolean }>().disabled).toBe(true);
    expect((await call(e, miaS, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await e.login('Mia Maria')).res.statusCode).toBe(401);
    await call(e, s, 'PATCH', `/api/admin/users/${mia.id}`, { disabled: false });
    const again = await e.login('Mia Maria');
    expect(again.res.statusCode).toBe(200);
    await call(e, s, 'PATCH', `/api/admin/users/${mia.id}`, { password: 'a brand new password' });
    expect((await call(e, again, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await e.login('Mia Maria', 'a brand new password')).res.statusCode).toBe(200);
    const actions = e.db.prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'user.%'").all() as Array<{ action: string; detail: string }>;
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(['user.update', 'user.disable', 'user.enable', 'user.password.reset']));
    expect(JSON.stringify(actions)).not.toContain('a brand new password');
  });

  it('cannot delete last admin (409)', async () => {
    const { e, admin, s } = await adminEnv();
    const res = await call(e, s, 'DELETE', `/api/admin/users/${admin.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('conflict');
    expect(e.db.prepare('SELECT 1 FROM users WHERE id = ?').get(admin.id)).toBeTruthy();
  });

  it('the last enabled admin cannot be demoted or disabled; with a second admin it can', async () => {
    const { e, admin, s } = await adminEnv();
    expect((await call(e, s, 'PATCH', `/api/admin/users/${admin.id}`, { role: 'member' })).statusCode).toBe(409);
    expect((await call(e, s, 'PATCH', `/api/admin/users/${admin.id}`, { disabled: true })).statusCode).toBe(409);
    const two = await e.addUser('Second', 'admin');
    const ok = await call(e, s, 'PATCH', `/api/admin/users/${admin.id}`, { role: 'member' });
    expect(ok.statusCode).toBe(200);
    // Now Second is the last one (and Root lost admin rights, so use Second's session).
    const s2 = await e.login('Second');
    expect((await call(e, s2, 'PATCH', `/api/admin/users/${two.id}`, { disabled: true })).statusCode).toBe(409);
  });

  it('deleting a user removes sessions, grants and app passwords and fires grant callbacks', async () => {
    const { e, s } = await adminEnv();
    const mia = await e.addUser('Mia');
    const miaS = await e.login('Mia');
    e.auth.grants.setGrant({ id: 'x', name: 'x', handle: 'x', role: 'admin' }, { userId: mia.id, moduleId: 'notes', level: 'edit' });
    const ap = await call(e, miaS, 'POST', '/api/me/app-passwords', { label: 'phone' });
    expect(ap.statusCode).toBe(201);
    const cb = vi.fn();
    e.auth.onGrantsChanged(cb);
    const res = await call(e, s, 'DELETE', `/api/admin/users/${mia.id}`);
    expect(res.statusCode).toBe(204);
    expect(cb).toHaveBeenCalledWith(mia.id, 'notes', 'none');
    for (const t of ['sessions', 'grants', 'app_passwords', 'users']) {
      expect(e.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === 'users' ? 'id' : 'user_id'} = ?`).get(mia.id)).toEqual({ n: 0 });
    }
    expect(e.auth.grants.listGrants()).toEqual([]);
    expect((await call(e, s, 'DELETE', `/api/admin/users/${mia.id}`)).statusCode).toBe(404);
  });

  it('a failing delete transaction leaves grants rows, in-memory levels and the user intact and fires no callback', async () => {
    const { e, s } = await adminEnv();
    const mia = await e.addUser('Mia');
    e.auth.grants.setGrant({ id: 'x', name: 'x', handle: 'x', role: 'admin' }, { userId: mia.id, moduleId: 'notes', level: 'edit' });
    e.db.exec("CREATE TRIGGER block_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
    const cb = vi.fn();
    e.auth.onGrantsChanged(cb);
    const res = await call(e, s, 'DELETE', `/api/admin/users/${mia.id}`);
    expect(res.statusCode).toBe(500);
    expect(cb).not.toHaveBeenCalled();
    expect(e.db.prepare('SELECT COUNT(*) AS n FROM grants WHERE user_id = ?').get(mia.id)).toEqual({ n: 1 });
    expect(e.db.prepare('SELECT 1 FROM users WHERE id = ?').get(mia.id)).toBeTruthy();
    expect(e.auth.levelFor(mia.id, 'notes')).toBe('edit');
    expect(e.auth.grants.listGrants()).toHaveLength(1);
  });

  it('POST /api/me/password keeps the current session, ends the others and verifies the current password', async () => {
    const { e } = await adminEnv();
    await e.addUser('Mia');
    const a = await e.login('Mia');
    const b = await e.login('Mia');
    const wrong = await call(e, a, 'POST', '/api/me/password', { current: 'not the password!', next: 'another good password' });
    expect(wrong.statusCode).toBe(403);
    expect((await call(e, a, 'POST', '/api/me/password', { current: PASSWORD, next: 'short' })).statusCode).toBe(422);
    expect((await call(e, null, 'POST', '/api/me/password', { current: PASSWORD, next: 'another good password' }, { cookie: a.cookie })).statusCode).toBe(403);
    const ok = await call(e, a, 'POST', '/api/me/password', { current: PASSWORD, next: 'another good password' });
    expect(ok.statusCode).toBe(204);
    expect((await call(e, a, 'GET', '/api/me')).statusCode).toBe(200);
    expect((await call(e, b, 'GET', '/api/me')).statusCode).toBe(401);
    expect((await e.login('Mia', 'another good password')).res.statusCode).toBe(200);
    expect(e.db.prepare("SELECT 1 FROM audit_log WHERE action = 'user.password.change'").get()).toBeTruthy();
  });
});
