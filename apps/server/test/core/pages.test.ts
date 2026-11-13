/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { afterEach, describe, expect, it } from 'vitest';
import { clampLayout, createInstanceReader, firstFreeSlot } from '../../src/core/instances.ts';
import { ensureStarterPage } from '../../src/core/pages.ts';
import { uuidv7 } from '../../src/core/ids.ts';
import { makeEnv, type Env } from './pages-env.ts';

let env: Env;
afterEach(async () => {
  await env.app.close();
});

async function page(as: string, body: object = { name: 'P' }): Promise<any> {
  const r = await env.call('POST', '/api/pages', as, body);
  expect(r.status).toBe(200);
  return r.json;
}

async function place(as: string, pageId: string, moduleId: string, extra: object = {}): Promise<any> {
  return env.call('POST', '/api/instances', as, { moduleId, pageId, ...extra });
}

describe('pages', () => {
  it('lazily creates the starter page "Today"', async () => {
    env = await makeEnv();
    const r = await env.call('GET', '/api/pages', 'alice');
    expect(r.json).toHaveLength(1);
    expect(r.json[0]).toMatchObject({ name: 'Today', ownerId: 'alice', shared: false, instances: [] });
    expect((await env.call('GET', '/api/pages', 'alice')).json).toHaveLength(1);
    expect(ensureStarterPage(env.db, 'alice', () => new Date())).toBeUndefined();
  });

  it('requires a session and CSRF', async () => {
    env = await makeEnv();
    expect((await env.call('GET', '/api/pages', null)).status).toBe(401);
    const res = await env.app.inject({ method: 'POST', url: '/api/pages', headers: { 'x-test-user': 'alice' }, payload: { name: 'x' } });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an invalid body with 422 and issues', async () => {
    env = await makeEnv();
    const r = await env.call('POST', '/api/pages', 'alice', { name: '' });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('invalid');
    expect(r.json.error.details.issues.length).toBeGreaterThan(0);
  });

  it("member cannot edit another user's page (403)", async () => {
    env = await makeEnv();
    const shared = await page('alice', { name: 'Shared', shared: true });
    const priv = await page('alice', { name: 'Private' });
    // non-owner PATCH on a shared page: visible, so 403
    expect((await env.call('PATCH', `/api/pages/${shared.id}`, 'bob', { name: 'Hacked' })).status).toBe(403);
    expect((await env.call('PUT', `/api/pages/${shared.id}/layout`, 'bob', { items: [] })).status).toBe(403);
    expect((await env.call('DELETE', `/api/pages/${shared.id}`, 'bob')).status).toBe(403);
    // a page that is neither owned nor shared does not exist for bob
    expect((await env.call('PATCH', `/api/pages/${priv.id}`, 'bob', { name: 'x' })).status).toBe(404);
    expect((await env.call('PATCH', `/api/pages/${shared.id}`, 'alice', { name: 'Mine' })).json.name).toBe('Mine');
  });

  it('shared page is visible to others but instances of ungranted modules are omitted', async () => {
    env = await makeEnv();
    const p = await page('alice', { name: 'Shared', shared: true });
    expect((await place('alice', p.id, 'demo')).status).toBe(200);
    expect((await place('alice', p.id, 'multi')).status).toBe(200);
    env.auth.grants['bob:multi'] = 'none';
    const bob = (await env.call('GET', '/api/pages', 'bob')).json as any[];
    const seen = bob.find((x) => x.id === p.id);
    expect(seen.instances.map((i: any) => i.moduleId)).toEqual(['demo']);
    const alice = (await env.call('GET', '/api/pages', 'alice')).json as any[];
    expect(alice.find((x) => x.id === p.id).instances).toHaveLength(2);
    // a disabled module's instances are omitted for everyone
    env.modules.find((m) => m.id === 'demo')!.enabled = false;
    expect(((await env.call('GET', '/api/pages', 'alice')).json as any[]).find((x) => x.id === p.id).instances).toHaveLength(1);
  });

  it('last page cannot be deleted', async () => {
    env = await makeEnv();
    const only = (await env.call('GET', '/api/pages', 'alice')).json[0];
    const r = await env.call('DELETE', `/api/pages/${only.id}`, 'alice');
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('conflict');
  });

  it('deleting a page deletes its instances and snapshots', async () => {
    env = await makeEnv();
    await env.call('GET', '/api/pages', 'alice');
    const p = await page('alice', { name: 'Two' });
    const inst = (await place('alice', p.id, 'demo')).json;
    env.db.prepare('INSERT INTO snapshots (module_id, instance_id, data, updated_at) VALUES (?,?,?,?)').run('demo', inst.id, '{}', 'x');
    env.db.prepare('INSERT INTO snapshots (module_id, instance_id, data, updated_at) VALUES (?,?,?,?)').run('demo', null, '{}', 'x');
    env.changes.length = 0;
    env.synced.length = 0;
    expect((await env.call('DELETE', `/api/pages/${p.id}`, 'alice')).status).toBe(204);
    expect(env.db.prepare('SELECT COUNT(*) FROM instances').pluck().get()).toBe(0);
    expect(env.db.prepare('SELECT COUNT(*) FROM snapshots WHERE instance_id = ?').pluck().get(inst.id)).toBe(0);
    expect(env.db.prepare('SELECT COUNT(*) FROM snapshots').pluck().get()).toBe(1); // module-wide row stays
    expect(env.changes.map((c) => c.kind)).toEqual(['removed']);
    expect(env.synced).toEqual(['demo']);
  });

  it('PUT layout ignores foreign instance ids and clamps', async () => {
    env = await makeEnv();
    const a = await page('alice');
    const b = await page('bob');
    const ia = (await place('alice', a.id, 'demo')).json;
    const ib = (await place('bob', b.id, 'multi')).json;
    const r = await env.call('PUT', `/api/pages/${a.id}/layout`, 'alice', {
      items: [
        { id: ia.id, layout: { x: 20, y: -3, w: 99, h: 0 }, mobileOrder: 5 },
        { id: ib.id, layout: { x: 7, y: 7, w: 1, h: 1 }, mobileOrder: 9 },
      ],
    });
    expect(r.status).toBe(204);
    const row = env.db.prepare('SELECT x,y,w,h,mobile_order AS m FROM instances WHERE id = ?').get(ia.id);
    expect(row).toEqual({ x: 8, y: 0, w: 4, h: 1, m: 5 });
    expect(env.db.prepare('SELECT x,y,w,h FROM instances WHERE id = ?').get(ib.id)).toMatchObject({ x: ib.layout.x, y: ib.layout.y });
    expect(env.streamed.some((s) => s.userId === 'alice' && s.ev.type === 'layout' && s.ev.pageId === a.id)).toBe(true);
  });
});

describe('instances', () => {
  it('instance settings validated, defaults applied', async () => {
    env = await makeEnv();
    const p = await page('alice');
    const ok = await place('alice', p.id, 'demo', { settings: {} });
    expect(ok.status).toBe(200);
    expect(ok.json.settings).toEqual({ city: 'Berlin' });
    expect(JSON.parse(env.db.prepare('SELECT settings FROM instances WHERE id = ?').pluck().get(ok.json.id) as string)).toEqual({ city: 'Berlin' });
    const bad = await place('alice', p.id, 'multi', { settings: { x: 1 } });
    expect(bad.status).toBe(200); // multi has an empty settings object, extras are stripped
    const p2 = await page('bob');
    const invalid = await place('bob', p2.id, 'demo', { settings: { n: 'nope' } });
    expect(invalid.status).toBe(422);
    expect(invalid.json.error.details.issues.length).toBeGreaterThan(0);
    const patched = await env.call('PATCH', `/api/instances/${ok.json.id}`, 'alice', { settings: { city: 'Paris' } });
    expect(patched.json.settings).toEqual({ city: 'Paris' });
    expect((await env.call('PATCH', `/api/instances/${ok.json.id}`, 'alice', { settings: { city: 5 } })).status).toBe(422);
  });

  it('second instance of single-instance module → 409', async () => {
    env = await makeEnv();
    const a = await page('alice');
    const b = await page('alice', { name: 'Other' });
    expect((await place('alice', a.id, 'demo')).status).toBe(200);
    const again = await place('alice', b.id, 'demo');
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('conflict');
    // another user is unaffected
    expect((await place('bob', (await page('bob')).id, 'demo')).status).toBe(200);
  });

  it('layout clamps w to max', async () => {
    env = await makeEnv();
    const p = await page('alice');
    const r = await place('alice', p.id, 'demo', { layout: { w: 9, h: 9 } });
    expect(r.json.layout).toMatchObject({ w: 4, h: 4 });
    const moved = await env.call('PATCH', `/api/instances/${r.json.id}`, 'alice', { layout: { x: 11 } });
    expect(moved.json.layout).toEqual({ x: 8, y: 0, w: 4, h: 4 }); // x + w <= 12
    expect(clampLayout({ x: -4, y: -1, w: 0, h: 0 }, { min: { w: 1, h: 2 }, max: { w: 3, h: 3 } })).toEqual({ x: 0, y: 0, w: 1, h: 2 });
  });

  it('places at the first free slot with the default size and last mobileOrder', async () => {
    env = await makeEnv();
    const p = await page('alice');
    const a = (await place('alice', p.id, 'demo')).json;
    const b = (await place('alice', p.id, 'multi')).json;
    const c = (await place('alice', p.id, 'secret')).json;
    expect(a.layout).toEqual({ x: 0, y: 0, w: 2, h: 2 });
    expect(b.layout).toEqual({ x: 2, y: 0, w: 2, h: 2 });
    expect(c.layout).toEqual({ x: 4, y: 0, w: 2, h: 2 });
    expect([a.mobileOrder, b.mobileOrder, c.mobileOrder]).toEqual([0, 1, 2]);
    expect(firstFreeSlot([{ x: 0, y: 0, w: 12, h: 1 }], 2, 2)).toEqual({ x: 0, y: 1 });
  });

  it('create needs page ownership, a grant and an enabled module', async () => {
    env = await makeEnv();
    const p = await page('alice', { name: 'S', shared: true });
    expect((await place('bob', p.id, 'multi')).status).toBe(403); // shared, not owner
    expect((await place('bob', 'nope', 'multi')).status).toBe(404);
    env.auth.grants['alice:multi'] = 'none';
    expect((await place('alice', p.id, 'multi')).status).toBe(403);
    expect((await place('alice', p.id, 'unknown')).status).toBe(404);
    env.modules.find((m) => m.id === 'secret')!.enabled = false;
    expect((await place('alice', p.id, 'secret')).status).toBe(404); // documented: disabled module behaves as unknown
    env.auth.grants['alice:multi'] = 'view';
    expect((await place('alice', p.id, 'multi')).status).toBe(200);
  });

  it('calls onInstanceChange, syncs the scheduler and sends layout events; hook errors do not fail the request', async () => {
    env = await makeEnv({ failOnChange: true });
    const p = await page('alice', { name: 'S', shared: true });
    const r = await place('alice', p.id, 'demo');
    expect(r.status).toBe(200);
    expect(env.changes.map((c) => c.kind)).toEqual(['added']);
    expect(env.changes[0]?.instance).toMatchObject({ id: r.json.id, ownerId: 'alice', pageId: p.id });
    expect(env.synced).toEqual(['demo']);
    expect(env.streamed.filter((s) => s.ev.type === 'layout' && s.userId === 'bob')).not.toHaveLength(0);
    await env.call('PATCH', `/api/instances/${r.json.id}`, 'alice', { mobileOrder: 3 });
    expect((await env.call('DELETE', `/api/instances/${r.json.id}`, 'alice')).status).toBe(204);
    expect(env.changes.map((c) => c.kind)).toEqual(['added', 'updated', 'removed']);
    expect(env.db.prepare('SELECT COUNT(*) FROM instances').pluck().get()).toBe(0);
  });

  it('non-owner cannot patch or delete an instance on a shared page', async () => {
    env = await makeEnv();
    const p = await page('alice', { name: 'S', shared: true });
    const i = (await place('alice', p.id, 'demo')).json;
    expect((await env.call('PATCH', `/api/instances/${i.id}`, 'bob', { mobileOrder: 1 })).status).toBe(403);
    expect((await env.call('DELETE', `/api/instances/${i.id}`, 'bob')).status).toBe(403);
    expect((await env.call('DELETE', `/api/instances/none`, 'bob')).status).toBe(404);
  });

  it('createInstanceReader and ModuleStateDep return placed instances and stored config', async () => {
    env = await makeEnv();
    const p = await page('alice');
    const i = (await place('alice', p.id, 'demo')).json;
    expect(createInstanceReader(env.db)('demo')).toEqual([{ id: i.id, ownerId: 'alice', pageId: p.id, settings: { city: 'Berlin' } }]);
    const host = env.modules.find((m) => m.id === 'demo')!.host;
    expect(await host.instances()).toHaveLength(1);
    await env.call('PUT', '/api/admin/modules/cfgmod/config', 'root', { apiBase: 'https://x', limit: 7 });
    expect(await env.modules.find((m) => m.id === 'cfgmod')!.host.config()).toEqual({ apiBase: 'https://x', limit: 7 });
  });
});

describe('ids', () => {
  it('uuidv7 is version 7 and sorts by time', () => {
    const a = uuidv7(new Date('2026-01-01T00:00:00Z'));
    const b = uuidv7(new Date('2026-01-01T00:00:01Z'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe('admin module API', () => {
  it('module config PUT validates with manifest.config and is admin-only', async () => {
    env = await makeEnv();
    expect((await env.call('PUT', '/api/admin/modules/cfgmod/config', 'alice', { limit: 3 })).status).toBe(403);
    expect((await env.call('GET', '/api/admin/modules', 'alice')).status).toBe(403);
    const bad = await env.call('PUT', '/api/admin/modules/cfgmod/config', 'root', { limit: 0 });
    expect(bad.status).toBe(422);
    expect(bad.json.error.details.issues.length).toBeGreaterThan(0);
    const ok = await env.call('PUT', '/api/admin/modules/cfgmod/config', 'root', { limit: 3 });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ apiBase: 'x', limit: 3 });
    expect((await env.call('GET', '/api/admin/modules/cfgmod/config', 'root')).json).toEqual({ apiBase: 'x', limit: 3 });
    expect((await env.call('GET', '/api/admin/modules/nope/config', 'root')).status).toBe(404);
    expect(env.audits.map((a) => a.action)).toEqual(['admin.module.config']);
  });

  it('lists modules for admins', async () => {
    env = await makeEnv();
    const r = await env.call('GET', '/api/admin/modules', 'root');
    expect(r.status).toBe(200);
    const cfg = r.json.find((m: any) => m.id === 'cfgmod');
    expect(cfg).toMatchObject({ enabled: true, failed: false, hasConfig: true, levels: ['view', 'edit'], version: '1.0.0' });
    expect(r.json.find((m: any) => m.id === 'demo').hasConfig).toBe(false);
  });

  it('enabling and disabling a module is admin-only and audited', async () => {
    env = await makeEnv();
    expect((await env.call('PUT', '/api/admin/modules/demo/enabled', 'alice', { enabled: false })).status).toBe(403);
    expect(env.audits).toHaveLength(0);
    const p = await page('alice');
    await place('alice', p.id, 'demo');
    const off = await env.call('PUT', '/api/admin/modules/demo/enabled', 'root', { enabled: false });
    expect(off.json).toEqual({ id: 'demo', enabled: false });
    expect(env.modules.find((m) => m.id === 'demo')!.enabled).toBe(false);
    expect(env.db.prepare("SELECT enabled FROM module_state WHERE module_id = 'demo'").pluck().get()).toBe(0);
    expect(env.registered.at(-1)).toEqual({ id: 'demo', enabled: false });
    expect(env.streamed.some((s) => s.userId === 'alice' && s.ev.type === 'revoked')).toBe(true);
    expect(env.audits.at(-1)).toMatchObject({ userId: 'root', action: 'admin.module.disable', detail: { moduleId: 'demo' } });
    await env.call('PUT', '/api/admin/modules/demo/enabled', 'root', { enabled: true });
    expect(env.modules.find((m) => m.id === 'demo')!.enabled).toBe(true);
    expect(env.audits.at(-1)?.action).toBe('admin.module.enable');
    expect(env.db.prepare('SELECT COUNT(*) FROM audit_log').pluck().get()).toBe(2);
    expect((await env.call('PUT', '/api/admin/modules/demo/enabled', 'root', { enabled: 'yes' })).status).toBe(422);
  });
});
