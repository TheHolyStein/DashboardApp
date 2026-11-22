import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAudit } from '../../src/core/audit.ts';
import { createAuth, disableUser } from '../../src/auth/index.ts';
import { loadConfig } from '../../src/core/config.ts';
import { makeAuthEnv, type AuthEnv } from './env.ts';

const MODULES = [
  { id: 'notes', levels: ['view', 'edit'] as const },
  { id: 'clock', levels: ['view'] as const },
];

let env: AuthEnv;
/** A fresh createAuth over the same database (cold caches, as after a restart). */
const fresh = (): ReturnType<typeof createAuth> =>
  createAuth(
    { db: env.db, audit: createAudit(env.db, () => env.clock.now), config: loadConfig({ NODE_ENV: 'test' }) },
    { modules: () => MODULES.map((m) => ({ id: m.id, levels: [...m.levels] })) },
  );
afterEach(async () => {
  await env.app.close();
});

async function setup(): Promise<{
  admin: { cookie: string; csrf: string; res?: unknown };
  member: { id: string };
  put: (body: unknown, who?: { cookie: string; csrf: string }, noCsrf?: boolean) => Promise<{ statusCode: number }>;
}> {
  env = await makeAuthEnv({ modules: MODULES.map((m) => ({ id: m.id, levels: [...m.levels] })), auth: { verifyPassword: () => Promise.resolve(true) } });
  await env.addUser('Ada', 'admin');
  const member = await env.addUser('Ben', 'member');
  const admin = await env.login('Ada');
  const put = (body: unknown, who: { cookie: string; csrf: string } = admin, noCsrf = false) =>
    env.app.inject({
      method: 'PUT',
      url: '/api/admin/grants',
      headers: { cookie: who.cookie, ...(noCsrf ? {} : { 'x-csrf': who.csrf }) },
      payload: body as object,
    });
  return { admin, member, put };
}

describe('grants', () => {
  it('admin is always edit', async () => {
    const { admin } = await setup();
    const adminUser = env.auth.listUsers().find((u) => u.role === 'admin');
    expect(env.auth.levelFor(adminUser?.id ?? '', 'notes')).toBe('edit');
    expect(env.auth.levelFor(adminUser?.id ?? '', 'clock')).toBe('edit');
    expect(env.auth.levelFor(adminUser?.id ?? '', 'nope')).toBe('none');
    expect(admin.csrf).not.toBe('');
  });

  it('member default none', async () => {
    const { member } = await setup();
    expect(env.auth.levelFor(member.id, 'notes')).toBe('none');
  });

  it("grant 'edit' on a view-only module → 422", async () => {
    const { member, put } = await setup();
    const res = await put({ userId: member.id, moduleId: 'clock', level: 'edit' });
    expect(res.statusCode).toBe(422);
    expect(env.auth.levelFor(member.id, 'clock')).toBe('none');
  });

  it('change fires callback with new level', async () => {
    const { member, put } = await setup();
    const cb = vi.fn();
    env.auth.onGrantsChanged(cb);
    const res = await put({ userId: member.id, moduleId: 'notes', level: 'edit' });
    expect(res.statusCode).toBe(204);
    expect(cb).toHaveBeenCalledWith(member.id, 'notes', 'edit');
    expect(env.auth.levelFor(member.id, 'notes')).toBe('edit');
  });

  it('non-admin cannot PUT grants (403)', async () => {
    const { member, put } = await setup();
    const ben = await env.login('Ben');
    const res = await put({ userId: member.id, moduleId: 'notes', level: 'edit' }, ben);
    expect(res.statusCode).toBe(403);
    expect(env.auth.levelFor(member.id, 'notes')).toBe('none');
  });

  it('none deletes the row and fires the callback with none', async () => {
    const { member, put } = await setup();
    await put({ userId: member.id, moduleId: 'notes', level: 'view' });
    const cb = vi.fn();
    env.auth.onGrantsChanged(cb);
    expect((await put({ userId: member.id, moduleId: 'notes', level: 'none' })).statusCode).toBe(204);
    expect(cb).toHaveBeenCalledWith(member.id, 'notes', 'none');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM grants').get()).toEqual({ n: 0 });
  });

  it('no callback when the level is unchanged', async () => {
    const { member, put } = await setup();
    await put({ userId: member.id, moduleId: 'notes', level: 'view' });
    const cb = vi.fn();
    env.auth.onGrantsChanged(cb);
    await put({ userId: member.id, moduleId: 'notes', level: 'view' });
    await put({ userId: member.id, moduleId: 'clock', level: 'none' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('a throwing callback does not stop the others or fail the request', async () => {
    const { member, put } = await setup();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const second = vi.fn();
    env.auth.onGrantsChanged(() => {
      throw new Error('boom');
    });
    env.auth.onGrantsChanged(second);
    const res = await put({ userId: member.id, moduleId: 'notes', level: 'view' });
    expect(res.statusCode).toBe(204);
    expect(second).toHaveBeenCalledWith(member.id, 'notes', 'view');
    spy.mockRestore();
  });

  it('grant for unknown module or user → 404; for an admin → 422', async () => {
    const { member, put } = await setup();
    expect((await put({ userId: member.id, moduleId: 'ghost', level: 'view' })).statusCode).toBe(404);
    expect((await put({ userId: 'nobody', moduleId: 'notes', level: 'view' })).statusCode).toBe(404);
    const adminId = env.auth.listUsers().find((u) => u.role === 'admin')?.id ?? '';
    expect((await put({ userId: adminId, moduleId: 'notes', level: 'view' })).statusCode).toBe(422);
    expect((await put({ userId: member.id, moduleId: 'notes', level: 'bogus' })).statusCode).toBe(422);
  });

  it('stored edit on a module that now supports only view resolves to view', async () => {
    const { member, put } = await setup();
    await put({ userId: member.id, moduleId: 'notes', level: 'edit' });
    const shrinking = [{ id: 'notes', levels: ['view'] as Array<'view' | 'edit'> }];
    const auth2 = createAuth(
      { db: env.db, audit: createAudit(env.db, () => env.clock.now), config: loadConfig({ NODE_ENV: 'test' }) },
      { modules: () => shrinking },
    );
    expect(auth2.levelFor(member.id, 'notes')).toBe('view');
    shrinking[0] = { id: 'notes', levels: [] };
    expect(auth2.levelFor(member.id, 'notes')).toBe('none');
  });

  it('PUT without X-CSRF → 403', async () => {
    const { member, put } = await setup();
    const res = await put({ userId: member.id, moduleId: 'notes', level: 'view' }, undefined, true);
    expect(res.statusCode).toBe(403);
  });

  it('the cache is rebuilt from the table on a fresh createAuth', async () => {
    const { member, put } = await setup();
    await put({ userId: member.id, moduleId: 'notes', level: 'view' });
    const auth2 = createAuth(
      { db: env.db, audit: createAudit(env.db, () => env.clock.now), config: loadConfig({ NODE_ENV: 'test' }) },
      { modules: () => MODULES.map((m) => ({ id: m.id, levels: [...m.levels] })) },
    );
    expect(auth2.levelFor(member.id, 'notes')).toBe('view');
  });

  it('promoting a member via applyUserChange fires edit for every module', async () => {
    const { member } = await setup();
    const cb = vi.fn();
    env.auth.onGrantsChanged(cb);
    env.auth.applyUserChange(member.id, () => {
      env.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(member.id);
    });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledWith(member.id, 'notes', 'edit');
    expect(cb).toHaveBeenCalledWith(member.id, 'clock', 'edit');
  });

  it('demoting a cold-cache admin on a fresh createAuth fires the member levels', async () => {
    const { member, put } = await setup();
    const adminId = env.auth.listUsers().find((u) => u.role === 'admin')?.id ?? '';
    // A stored row for the admin only matters after demotion.
    env.db.prepare("INSERT INTO grants (user_id, module_id, level) VALUES (?, 'notes', 'view')").run(adminId);
    await put({ userId: member.id, moduleId: 'clock', level: 'view' });
    const auth2 = fresh();
    const cb = vi.fn();
    auth2.onGrantsChanged(cb);
    auth2.applyUserChange(adminId, () => {
      env.db.prepare("UPDATE users SET role = 'member' WHERE id = ?").run(adminId);
    });
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledWith(adminId, 'notes', 'view');
    expect(cb).toHaveBeenCalledWith(adminId, 'clock', 'none');
  });

  it('disabling a member with grants fires none for each granted module', async () => {
    const { member, put } = await setup();
    await put({ userId: member.id, moduleId: 'notes', level: 'edit' });
    await put({ userId: member.id, moduleId: 'clock', level: 'view' });
    const auth2 = fresh();
    const cb = vi.fn();
    auth2.onGrantsChanged(cb);
    disableUser({ ...env.deps, applyChange: (id, m) => auth2.applyUserChange(id, m) }, member.id);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenCalledWith(member.id, 'notes', 'none');
    expect(cb).toHaveBeenCalledWith(member.id, 'clock', 'none');
    expect(auth2.levelFor(member.id, 'notes')).toBe('none');
  });

  it('deleting a user with grants removes the rows and fires none', async () => {
    const { member, put } = await setup();
    await put({ userId: member.id, moduleId: 'notes', level: 'view' });
    const cb = vi.fn();
    env.auth.onGrantsChanged(cb);
    env.auth.applyUserChange(member.id, () => {
      env.auth.removeUserGrants(member.id);
      env.db.prepare('DELETE FROM users WHERE id = ?').run(member.id);
    });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(member.id, 'notes', 'none');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM grants').get()).toEqual({ n: 0 });
    expect(env.auth.levelFor(member.id, 'notes')).toBe('none');
  });

  it('enabling a disabled member with stored grants fires their levels', async () => {
    const { member, put } = await setup();
    await put({ userId: member.id, moduleId: 'notes', level: 'edit' });
    disableUser(env.deps, member.id);
    const auth2 = fresh();
    const cb = vi.fn();
    auth2.onGrantsChanged(cb);
    auth2.applyUserChange(member.id, () => {
      env.db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(member.id);
    });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(member.id, 'notes', 'edit');
  });

  it('a throwing audit still fires the callback', async () => {
    const { member } = await setup();
    const auth2 = createAuth(
      {
        db: env.db,
        audit: () => {
          throw new Error('audit down');
        },
        config: loadConfig({ NODE_ENV: 'test' }),
      },
      { modules: () => MODULES.map((m) => ({ id: m.id, levels: [...m.levels] })) },
    );
    const cb = vi.fn();
    auth2.onGrantsChanged(cb);
    const actor = { id: 'x', name: 'x', handle: 'x', role: 'admin' as const };
    expect(() => auth2.grants.setGrant(actor, { userId: member.id, moduleId: 'notes', level: 'view' })).toThrow('audit down');
    expect(cb).toHaveBeenCalledWith(member.id, 'notes', 'view');
  });

  it('GET /api/me shows the new level after a change; GET /api/admin/grants lists rows', async () => {
    const { member, admin, put } = await setup();
    const ben = await env.login('Ben');
    await put({ userId: member.id, moduleId: 'notes', level: 'view' });
    const me = await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: ben.cookie } });
    expect(me.json<{ grants: Record<string, string> }>().grants).toEqual({ notes: 'view', clock: 'none' });
    const list = await env.app.inject({ method: 'GET', url: '/api/admin/grants', headers: { cookie: admin.cookie } });
    expect(list.json()).toEqual([{ userId: member.id, moduleId: 'notes', level: 'view' }]);
    const denied = await env.app.inject({ method: 'GET', url: '/api/admin/grants', headers: { cookie: ben.cookie } });
    expect(denied.statusCode).toBe(403);
  });

  it('removeUserGrants deletes the stored rows', async () => {
    const { member, put } = await setup();
    await put({ userId: member.id, moduleId: 'notes', level: 'view' });
    env.auth.removeUserGrants(member.id);
    expect(env.auth.levelFor(member.id, 'notes')).toBe('none');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM grants').get()).toEqual({ n: 0 });
  });
});
