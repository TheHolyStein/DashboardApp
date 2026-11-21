import { describe, expect, test } from 'vitest';
import type { ModuleInstance } from '@dash/contract';
import { createMockHostWithSetup, createMockRouter, runServerContractSuite } from '@dash/module-kit/testing';
import server from '../server/index.js';
import type { ListPage, MutesState, ReadResult, Snapshot } from '../manifest.js';
import { installFakeNotifications } from './fake-notifications.js';

runServerContractSuite(server, {
  moduleDir: import.meta.dirname + '/..',
  // Reading state and mutes are the caller's own: view level may write them.
  viewWrites: ['POST /read', 'PUT /mutes'],
});

const START = new Date('2026-11-12T08:00:00.000Z');
const inst = (id: string, ownerId: string): ModuleInstance => ({ id, ownerId, pageId: 'p1', settings: {} });

async function setup() {
  const host = await createMockHostWithSetup(server, {
    now: START,
    prepare: (h) => h.setInstances([inst('i1', 'u1'), inst('i2', 'u2'), inst('i3', 'u1')]),
  });
  const fake = installFakeNotifications(host);
  const router = createMockRouter(server, host);
  const as = (id: string) => ({ level: 'view' as const, user: { id } });
  const pushedTo = (id: string) => host.pushed.filter((p) => p.instanceId === id).map((p) => p.data as Snapshot);
  const last = (id: string): Snapshot => pushedTo(id).at(-1)!;
  /** Time moves between notifications so that their order is clear. */
  const tick = () => host.advance(1000);
  return { host, fake, router, as, pushedTo, last, tick };
}

describe('snapshot', () => {
  test('snapshot unread count follows created and read', async () => {
    const { fake, router, as, last, tick } = await setup();
    const a = await fake.create('u1', 'calendar', 'info', 'Standup in 5 min');
    tick();
    await fake.create('u1', 'nas', 'critical', 'NAS failed');
    expect(last('i1')).toMatchObject({ unread: 2 });
    expect(last('i1').latest.map((n) => n.title)).toEqual(['NAS failed', 'Standup in 5 min']);

    const read = await router.call('POST', '/read', { ...as('u1'), body: { ids: [a.id] } });
    expect(read.status).toBe(200);
    expect((read.body as ReadResult).unread).toBe(1);
    expect(last('i1')).toMatchObject({ unread: 1 });
    expect(last('i1').latest.map((n) => n.title)).toEqual(['NAS failed']);
  });

  test('every instance of the user gets the snapshot, with a rising rev and one epoch', async () => {
    const { fake, pushedTo, tick } = await setup();
    await fake.create('u1', 'nas', 'warn', 'one');
    tick();
    await fake.create('u1', 'nas', 'warn', 'two');
    for (const id of ['i1', 'i3']) {
      expect(pushedTo(id).map((s) => s.unread)).toEqual([1, 2]);
      expect(pushedTo(id).map((s) => s.rev)).toEqual([1, 2]);
    }
    expect(new Set([...pushedTo('i1'), ...pushedTo('i3')].map((s) => s.epoch)).size).toBe(1);
  });

  test('latest holds at most five of the newest unread notifications', async () => {
    const { fake, last, tick } = await setup();
    for (let i = 1; i <= 8; i++) {
      await fake.create('u1', 'nas', 'info', `n${i}`);
      tick();
    }
    expect(last('i1').unread).toBe(8);
    expect(last('i1').latest.map((n) => n.title)).toEqual(['n8', 'n7', 'n6', 'n5', 'n4']);
    expect(Object.keys(last('i1').latest[0]!).sort()).toEqual(['createdAt', 'id', 'level', 'moduleId', 'title']);
  });

  test('user only sees own notifications', async () => {
    const { fake, router, as, pushedTo, last } = await setup();
    await fake.create('u1', 'nas', 'critical', 'Secret for u1');
    expect(pushedTo('i2')).toEqual([]);
    expect(last('i1').latest.map((n) => n.title)).toEqual(['Secret for u1']);

    const mine = (await router.call('GET', '/list', { ...as('u1') })).body as ListPage;
    const theirs = (await router.call('GET', '/list', { ...as('u2') })).body as ListPage;
    expect(mine.items.map((n) => n.title)).toEqual(['Secret for u1']);
    expect(theirs.items).toEqual([]);

    // Someone else's id in the body changes nothing for them and nothing for the caller either.
    await router.call('POST', '/read', { ...as('u2'), body: { ids: mine.items.map((n) => n.id) } });
    expect(fake.rows[0]!.readAt).toBeNull();
    await router.call('POST', '/read', { ...as('u2'), body: { ids: 'all' } });
    expect(fake.rows[0]!.readAt).toBeNull();
  });

  test('muted module does not raise unread', async () => {
    const { fake, router, as, last, pushedTo, tick } = await setup();
    const mute = await router.call('PUT', '/mutes', { ...as('u1'), body: { moduleId: 'weather', until: 'forever' } });
    expect(mute.status).toBe(200);
    expect((mute.body as MutesState).mutes).toEqual({ weather: 'forever' });
    const before = pushedTo('i1').length;

    await fake.create('u1', 'weather', 'warn', 'Storm tonight'); // stored already read, no event
    expect(pushedTo('i1')).toHaveLength(before);
    expect(last('i1').unread).toBe(0);
    tick();
    await fake.create('u1', 'nas', 'warn', 'Disk slow');
    expect(last('i1')).toMatchObject({ unread: 1 });
    expect(last('i1').latest.map((n) => n.moduleId)).toEqual(['nas']);

    // Stored, though: the history still shows it.
    const page = (await router.call('GET', '/list', { ...as('u1') })).body as ListPage;
    expect(page.items.map((n) => n.title).sort()).toEqual(['Disk slow', 'Storm tonight']);
  });

  test('muting a module with unread notifications takes them out of the count, unmuting brings them back', async () => {
    const { fake, router, as, last, tick } = await setup();
    await fake.create('u1', 'weather', 'warn', 'Storm tonight');
    tick();
    await fake.create('u1', 'nas', 'warn', 'Disk slow');
    expect(last('i1').unread).toBe(2);
    await router.call('PUT', '/mutes', { ...as('u1'), body: { moduleId: 'weather', until: 'forever' } });
    expect(last('i1')).toMatchObject({ unread: 1 });
    expect(last('i1').latest.map((n) => n.title)).toEqual(['Disk slow']);
    await router.call('PUT', '/mutes', { ...as('u1'), body: { moduleId: 'weather', until: null } });
    expect(last('i1')).toMatchObject({ unread: 2 });
  });

  test('a mute that has run out no longer counts', async () => {
    const { fake, router, as, last, host, tick } = await setup();
    await fake.create('u1', 'weather', 'warn', 'Storm tonight');
    tick();
    await router.call('PUT', '/mutes', { ...as('u1'), body: { moduleId: 'weather', until: '2026-11-12T09:00:00.000Z' } });
    expect(last('i1').unread).toBe(0);
    host.setNow(new Date('2026-11-12T09:00:01.000Z'));
    await fake.create('u1', 'nas', 'info', 'later'); // any push rebuilds the snapshot
    expect(last('i1').unread).toBe(2);
  });

  test('mark all read', async () => {
    const { fake, router, as, last, pushedTo, tick } = await setup();
    await fake.create('u1', 'nas', 'warn', 'a');
    tick();
    await fake.create('u1', 'calendar', 'info', 'b');
    await fake.create('u2', 'nas', 'warn', 'other user');
    const res = await router.call('POST', '/read', { ...as('u1'), body: { ids: 'all' } });
    expect(res.status).toBe(200);
    expect((res.body as ReadResult).unread).toBe(0);
    expect(last('i1')).toMatchObject({ unread: 0, latest: [] });
    expect(fake.rows.filter((r) => r.userId === 'u2').map((r) => r.readAt)).toEqual([null]);
    expect(pushedTo('i3').at(-1)).toMatchObject({ unread: 0 });
    expect(last('i2')).toMatchObject({ unread: 1 });
  });
});

describe('routes', () => {
  test('GET /list pages by 50 with a cursor and filters by module and unread', async () => {
    const { fake, router, as, tick } = await setup();
    for (let i = 0; i < 60; i++) {
      await fake.create('u1', i % 2 === 0 ? 'nas' : 'calendar', 'info', `n${i}`);
      tick();
    }
    const first = (await router.call('GET', '/list', { ...as('u1') })).body as ListPage;
    expect(first.items).toHaveLength(50);
    expect(first.items[0]!.title).toBe('n59');
    expect(first.next).toBe(first.items[49]!.createdAt);
    const second = (await router.call('GET', '/list', { ...as('u1'), query: { before: first.next } })).body as ListPage;
    expect(second.items.map((n) => n.title)).toEqual(Array.from({ length: 10 }, (_, i) => `n${9 - i}`));
    expect(second.next).toBeNull();

    const nas = (await router.call('GET', '/list', { ...as('u1'), query: { moduleId: 'nas' } })).body as ListPage;
    expect(nas.items.every((n) => n.moduleId === 'nas')).toBe(true);
    expect(nas.items).toHaveLength(30);

    await router.call('POST', '/read', { ...as('u1'), body: { ids: [first.items[0]!.id] } });
    const unread = (await router.call('GET', '/list', { ...as('u1'), query: { unreadOnly: 'true', before: first.next } })).body as ListPage;
    expect(unread.items.every((n) => n.readAt === null)).toBe(true);
    expect(unread.items).toHaveLength(10);
  });

  test('GET /list keeps translation keys, vars and the url of the notification', async () => {
    const { fake, router, as } = await setup();
    await fake.create('u1', 'clock', 'info', 'Pasta', { titleKey: 'm.clock.notify.finished', vars: { label: 'Pasta' }, url: '/p/1' });
    const page = (await router.call('GET', '/list', { ...as('u1') })).body as ListPage;
    expect(page.items[0]).toMatchObject({ title: 'Pasta', titleKey: 'm.clock.notify.finished', vars: { label: 'Pasta' }, url: '/p/1' });
    expect(page.epoch).toBeTruthy();
  });

  test('GET /list rejects a bad query with 422', async () => {
    const { router, as } = await setup();
    expect((await router.call('GET', '/list', { ...as('u1'), query: { moduleId: 'Not A Module!' } })).status).toBe(422);
    expect((await router.call('GET', '/list', { ...as('u1'), query: { unreadOnly: 'maybe' } })).status).toBe(422);
  });

  test('POST /read rejects a bad body with 422', async () => {
    const { router, as } = await setup();
    expect((await router.call('POST', '/read', { ...as('u1'), body: { ids: 'some' } })).status).toBe(422);
    expect((await router.call('POST', '/read', { ...as('u1'), body: {} })).status).toBe(422);
  });

  test('GET and PUT /mutes: set, list, change and remove a mute', async () => {
    const { router, as } = await setup();
    expect(((await router.call('GET', '/mutes', { ...as('u1') })).body as MutesState).mutes).toEqual({});
    const until = '2026-11-12T10:00:00.000Z';
    await router.call('PUT', '/mutes', { ...as('u1'), body: { moduleId: 'weather', until } });
    await router.call('PUT', '/mutes', { ...as('u1'), body: { moduleId: 'nas', until: 'forever' } });
    expect(((await router.call('GET', '/mutes', { ...as('u1') })).body as MutesState).mutes).toEqual({ weather: until, nas: 'forever' });
    const removed = await router.call('PUT', '/mutes', { ...as('u1'), body: { moduleId: 'nas', until: null } });
    expect((removed.body as MutesState).mutes).toEqual({ weather: until });
    // Mutes are the caller's own.
    expect(((await router.call('GET', '/mutes', { ...as('u2') })).body as MutesState).mutes).toEqual({});
  });

  test('PUT /mutes rejects a bad module id, a bad time and a time in the past', async () => {
    const { router, as } = await setup();
    const put = (body: unknown) => router.call('PUT', '/mutes', { ...as('u1'), body });
    expect((await put({ moduleId: 'X', until: 'forever' })).status).toBe(422);
    expect((await put({ moduleId: 'nas', until: 'tomorrow' })).status).toBe(422);
    expect((await put({ moduleId: 'nas', until: '2026-11-12T07:00:00.000Z' })).status).toBe(422);
    expect((await put({ moduleId: 'nas' })).status).toBe(422);
  });

  test('without the privileged service the routes answer 500, the handler does nothing and setup still works', async () => {
    const host = await createMockHostWithSetup(server, { now: START, prepare: (h) => h.setInstances([inst('i1', 'u1')]) });
    const router = createMockRouter(server, host);
    expect((await router.call('GET', '/list', { level: 'view' })).status).toBe(500);
    await server.on!['notification.created']!({ id: 'x', userId: 'u1', moduleId: 'nas', level: 'info', title: 't', createdAt: START.toISOString() }, host);
    expect(host.pushed).toEqual([]);
  });
});

describe('instances', () => {
  test('a new instance gets the current snapshot at once, an unchanged one is not pushed twice', async () => {
    const { fake, host, pushedTo } = await setup();
    await fake.create('u1', 'nas', 'warn', 'a');
    const added = inst('i4', 'u1');
    host.setInstances([inst('i1', 'u1'), inst('i2', 'u2'), inst('i3', 'u1'), added]);
    await server.onInstanceChange!('added', added, host);
    expect(pushedTo('i4')).toHaveLength(1);
    expect(pushedTo('i4')[0]).toMatchObject({ unread: 1 });
    await server.onInstanceChange!('updated', added, host);
    expect(pushedTo('i4')).toHaveLength(1);
    expect(pushedTo('i1')).toHaveLength(1); // nothing new for the others either
  });

  test('setup removes the stored revision of users without an instance', async () => {
    const host = await createMockHostWithSetup(server, {
      now: START,
      prepare: (h) => {
        h.setInstances([inst('i1', 'u1')]);
        void h.store.set('rev:u1', 7);
        void h.store.set('rev:ghost', 3);
      },
    });
    expect(await host.store.keys()).toEqual(['rev:u1']);
  });

  test('the revision survives a restart and a new boot has a new epoch', async () => {
    const first = await setup();
    await first.fake.create('u1', 'nas', 'warn', 'a');
    const second = await createMockHostWithSetup(server, {
      now: START,
      prepare: (h) => {
        h.setInstances([inst('i1', 'u1')]);
        void h.store.set('rev:u1', first.last('i1').rev);
      },
    });
    const fake = installFakeNotifications(second);
    await fake.create('u1', 'nas', 'warn', 'b');
    const again = second.pushed.at(-1)!.data as Snapshot;
    expect(again.rev).toBe(first.last('i1').rev + 1);
    expect(again.epoch).not.toBe(first.last('i1').epoch);
  });
});
