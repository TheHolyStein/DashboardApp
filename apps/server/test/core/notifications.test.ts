/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { afterEach, describe, expect, it } from 'vitest';
import { purgeOldNotifications, safeUrl, type NotificationData } from '../../src/core/notifications.ts';
import { clock, makeEnv, type Env } from './pages-env.ts';

let env: Env;
afterEach(async () => {
  await env.app.close();
});

const rows = (env2: Env): any[] =>
  env2.db.prepare('SELECT * FROM notifications ORDER BY created_at, id').all() as any[];
const notified = (e: Env, userId: string): any[] => e.streamed.filter((s) => s.userId === userId && s.ev.type === 'notification');

describe('notifications', () => {
  it('dedupeKey updates instead of inserting', async () => {
    env = await makeEnv();
    env.notifications.notify('demo', { level: 'info', title: 'One', body: 'a', dedupeKey: 'k', userIds: ['alice'] });
    const first = rows(env)[0];
    await env.notifications.api.markRead('alice', 'all');
    clock.now = new Date('2026-11-12T12:00:00.000Z');
    env.notifications.notify('demo', { level: 'warn', title: 'Two', body: 'b', dedupeKey: 'k', url: '/x', userIds: ['alice'] });
    const all = rows(env);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: first.id, title: 'Two', body: 'b', level: 'warn', url: '/x', created_at: '2026-11-12T12:00:00.000Z', read_at: null,
    });
    expect(notified(env, 'alice')).toHaveLength(2);
  });

  it('dedupe after 24 h inserts a new row', async () => {
    env = await makeEnv();
    env.notifications.notify('demo', { level: 'info', title: 'One', dedupeKey: 'k', userIds: ['alice'] });
    clock.now = new Date('2026-11-13T10:00:01.000Z');
    env.notifications.notify('demo', { level: 'info', title: 'Two', dedupeKey: 'k', userIds: ['alice'] });
    expect(rows(env)).toHaveLength(2);
    // same key for another module or user never merges
    env.notifications.notify('multi', { level: 'info', title: 'Three', dedupeKey: 'k', userIds: ['alice'] });
    expect(rows(env)).toHaveLength(3);
  });

  it('notify publishes notification.created', async () => {
    env = await makeEnv();
    env.notifications.notify('demo', { level: 'critical', title: 'Boom', userIds: ['bob'] });
    const row = rows(env)[0];
    expect(env.published).toEqual([
      {
        from: 'core',
        name: 'notification.created',
        payload: { id: row.id, userId: 'bob', moduleId: 'demo', level: 'critical', title: 'Boom', createdAt: row.created_at },
      },
    ]);
    const ev = notified(env, 'bob')[0].ev;
    expect(ev.notification).toMatchObject({ id: row.id, moduleId: 'demo', title: 'Boom', readAt: null });
  });

  it('stores titleKey, bodyKey and vars, streams them, and returns them from the privileged list', async () => {
    env = await makeEnv();
    env.notifications.notify('demo', {
      level: 'info', title: 'Timer finished', body: 'Tea', titleKey: 'm.clock.notify.finished', bodyKey: 'm.clock.notify.body',
      vars: { label: 'Tea', n: 3 }, userIds: ['alice'],
    });
    expect(rows(env)[0]).toMatchObject({
      title: 'Timer finished', title_key: 'm.clock.notify.finished', body_key: 'm.clock.notify.body', vars: '{"label":"Tea","n":3}',
    });
    expect(notified(env, 'alice')[0].ev.notification).toMatchObject({
      titleKey: 'm.clock.notify.finished', bodyKey: 'm.clock.notify.body', vars: { label: 'Tea', n: 3 },
    });
    const list = await env.notifications.api.list('alice', { limit: 10 });
    expect(list[0]).toMatchObject({ titleKey: 'm.clock.notify.finished', vars: { label: 'Tea', n: 3 } });
  });

  it('without keys the fields are null; invalid keys and vars are dropped; a dedupe update replaces the keys', async () => {
    env = await makeEnv();
    env.notifications.notify('demo', { level: 'info', title: 'Plain', userIds: ['alice'] });
    expect(notified(env, 'alice')[0].ev.notification).toMatchObject({ titleKey: null, bodyKey: null, vars: null });
    env.notifications.notify('demo', {
      level: 'info', title: 'Bad', titleKey: 'not a key!', bodyKey: 'x'.repeat(101), vars: { a: { nested: 1 }, b: Number.NaN } as never, userIds: ['bob'],
    });
    expect(notified(env, 'bob')[0].ev.notification).toMatchObject({ titleKey: null, bodyKey: null, vars: null });
    env.notifications.notify('demo', { level: 'info', title: 'D1', titleKey: 'k.one', dedupeKey: 'd', userIds: ['alice'] });
    env.notifications.notify('demo', { level: 'info', title: 'D2', dedupeKey: 'd', userIds: ['alice'] });
    const d = rows(env).filter((r) => r.dedupe_key === 'd');
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ title: 'D2', title_key: null });
  });

  it('host.notifications is undefined for a non-privileged module', async () => {
    env = await makeEnv();
    expect(env.modules.find((m) => m.id === 'demo')!.host.notifications).toBeUndefined();
    expect(env.notifications.privileged('demo')).toBeUndefined();
    expect(env.notifications.privileged('notifications')).toBeDefined();
  });

  it("muted module's notification is stored read and not sent to sinks", async () => {
    env = await makeEnv();
    const sunk: NotificationData[] = [];
    env.notifications.registerNotificationSink((e) => void sunk.push(e.notification));
    await env.notifications.api.setMute('alice', 'demo', 'forever');
    await env.notifications.api.setMute('bob', 'demo', '2026-11-12T09:00:00.000Z'); // already expired
    env.notifications.notify('demo', { level: 'info', title: 'Hi', userIds: ['alice', 'bob'] });
    const byUser = Object.fromEntries(rows(env).map((r) => [r.user_id, r]));
    expect(byUser.alice.read_at).toBe('2026-11-12T10:00:00.000Z');
    expect(byUser.bob.read_at).toBeNull();
    expect(sunk.map((n) => n.title)).toEqual(['Hi']);
    expect(notified(env, 'alice')).toHaveLength(0);
    expect(notified(env, 'bob')).toHaveLength(1);
    expect(env.published).toHaveLength(1);
    expect(await env.notifications.api.getMutes('alice')).toEqual({ demo: 'forever' });
    expect(await env.notifications.api.getMutes('bob')).toEqual({});
    await env.notifications.api.setMute('alice', 'demo', null);
    expect(await env.notifications.api.getMutes('alice')).toEqual({});
  });

  it('notify without userIds targets every user with view on the module', async () => {
    env = await makeEnv();
    env.auth.grants['root:demo'] = 'none';
    env.auth.grants['bob:demo'] = 'view';
    env.notifications.notify('demo', { level: 'info', title: 'All' });
    expect(rows(env).map((r) => r.user_id).sort()).toEqual(['alice', 'bob']);
  });

  it('explicit userIds without grant receive nothing', async () => {
    env = await makeEnv();
    env.auth.grants['bob:demo'] = 'none';
    env.notifications.notify('demo', { level: 'info', title: 'X', userIds: ['bob', 'ghost'] });
    expect(rows(env)).toHaveLength(0);
    expect(env.streamed).toHaveLength(0);
    expect(env.published).toHaveLength(0);
  });

  it('notification url that is absolute is dropped', async () => {
    env = await makeEnv();
    for (const url of ['https://evil.example/x', '//evil.example', '/\\evil', 'javascript:alert(1)', 'rel/path', '/ok\nx']) {
      expect(safeUrl(url)).toBeNull();
    }
    expect(safeUrl('/calendar?day=2026-11-12')).toBe('/calendar?day=2026-11-12');
    env.notifications.notify('demo', { level: 'info', title: 'A', url: 'https://evil.example', userIds: ['alice'] });
    clock.now = new Date('2026-11-12T10:00:01.000Z');
    env.notifications.notify('demo', { level: 'info', title: 'B', url: '/todo', userIds: ['alice'] });
    expect(rows(env).map((r) => r.url)).toEqual([null, '/todo']);
  });

  it('truncates title and body', async () => {
    env = await makeEnv();
    env.notifications.notify('demo', { level: 'info', title: 't'.repeat(500), body: 'b'.repeat(5000), userIds: ['alice'] });
    expect(rows(env)[0].title).toHaveLength(200);
    expect(rows(env)[0].body).toHaveLength(2000);
  });

  it('isolates sink errors', async () => {
    env = await makeEnv();
    const seen: string[] = [];
    env.notifications.registerNotificationSink(() => {
      throw new Error('sync boom');
    });
    env.notifications.registerNotificationSink(() => Promise.reject(new Error('async boom')));
    env.notifications.registerNotificationSink((e) => void seen.push(e.userId));
    env.notifications.notify('demo', { level: 'info', title: 'x', userIds: ['alice'] });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['alice']);
  });

  it('GET /api/notifications lists own, newest first, with limit, before and unreadOnly', async () => {
    env = await makeEnv();
    for (const [i, h] of ['10', '11', '12'].entries()) {
      clock.now = new Date(`2026-11-12T${h}:00:00.000Z`);
      env.notifications.notify('demo', { level: 'info', title: `n${i}`, userIds: ['alice', 'bob'] });
    }
    const all = await env.call('GET', '/api/notifications', 'alice');
    expect(all.json.map((n: any) => n.title)).toEqual(['n2', 'n1', 'n0']);
    expect(all.json[0]).toEqual({
      id: expect.any(String), moduleId: 'demo', level: 'info', title: 'n2', titleKey: null, bodyKey: null, vars: null, body: null, url: null,
      createdAt: '2026-11-12T12:00:00.000Z', readAt: null,
    });
    expect((await env.call('GET', '/api/notifications?limit=1', 'alice')).json).toHaveLength(1);
    expect((await env.call('GET', '/api/notifications?limit=101', 'alice')).status).toBe(422);
    expect((await env.call('GET', '/api/notifications?before=2026-11-12T12:00:00.000Z', 'alice')).json).toHaveLength(2);
    const ids = [all.json[0].id];
    expect((await env.call('POST', '/api/notifications/read', 'alice', { ids })).status).toBe(204);
    expect((await env.call('GET', '/api/notifications?unreadOnly=true', 'alice')).json).toHaveLength(2);
    expect(await env.notifications.api.unreadCount('bob')).toBe(3); // others' state untouched
    expect((await env.call('POST', '/api/notifications/read', 'alice', { ids: 'all' })).status).toBe(204);
    expect(await env.notifications.api.unreadCount('alice')).toBe(0);
    expect((await env.call('POST', '/api/notifications/read', 'alice', { ids: 5 })).status).toBe(422);
    expect((await env.call('GET', '/api/notifications', null)).status).toBe(401);
  });

  it('purgeOldNotifications deletes rows older than 30 days', async () => {
    env = await makeEnv();
    env.notifications.notify('demo', { level: 'info', title: 'old', userIds: ['alice'] });
    clock.now = new Date('2026-12-20T10:00:00.000Z');
    env.notifications.notify('demo', { level: 'info', title: 'new', userIds: ['alice'] });
    expect(purgeOldNotifications(env.db, clock.now)).toBe(1);
    expect(rows(env).map((r) => r.title)).toEqual(['new']);
  });
});
