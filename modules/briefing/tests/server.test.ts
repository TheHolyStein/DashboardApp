import { describe, expect, test } from 'vitest';
import type { EventName, EventPayload, ModuleInstance } from '@dash/contract';
import { createMockHostWithSetup, createMockRouter, runServerContractSuite, type MockHost } from '@dash/module-kit/testing';
import server from '../server/index.js';
import { MAX_ALERTS, MAX_PINS, type UserState } from '../server/state.js';
import type { DayDetail, Snapshot } from '../manifest.js';

runServerContractSuite(server, { moduleDir: import.meta.dirname + '/..' });

const START = new Date('2026-11-12T07:30:00.000Z'); // 08:30 in Berlin, 07:30 in UTC
const inst = (id: string, ownerId: string): ModuleInstance => ({ id, ownerId, pageId: 'p1', settings: {} });

async function setup() {
  const host = await createMockHostWithSetup(server, {
    now: START,
    prepare: (h) => {
      h.setUsers([
        { id: 'u1', name: 'One', handle: 'one', timeZone: 'Europe/Berlin' },
        { id: 'u2', name: 'Two', handle: 'two', timeZone: 'UTC' },
        { id: 'u3', name: 'Three', handle: 'three', timeZone: 'UTC' }, // no briefing instance
      ]);
      h.setInstances([inst('i1', 'u1'), inst('i2', 'u2')]);
    },
  });
  const router = createMockRouter(server, host);
  const send = async <E extends EventName>(name: E, payload: EventPayload<E>): Promise<void> => {
    await server.on![name]!(payload as never, host);
  };
  const pushedTo = (id: string) => host.pushed.filter((p) => p.instanceId === id).map((p) => p.data as Snapshot);
  const last = (id: string): Snapshot => {
    const all = pushedTo(id);
    return all[all.length - 1]!;
  };
  const compose = () => server.jobs!['compose']!({ host, instance: null, signal: new AbortController().signal });
  return { host, router, send, pushedTo, last, compose };
}

const summary = (userId: string, title: string, start = '2026-11-12T09:00:00.000Z') => ({
  userId,
  date: '2026-11-12',
  events: [{ uid: `${userId}-1`, title, start, end: start, allDay: false, tags: [] }],
});

describe('event handlers', () => {
  test("user A's summary never appears in user B's snapshot", async () => {
    const { send, last, pushedTo } = await setup();
    await send('calendar.day.summary', summary('u1', 'Secret dentist'));
    await send('todo.day.summary', { userId: 'u1', date: '2026-11-12', overdue: 2, due: [{ id: 't', title: 'Private todo', list: 'week' }] });
    expect(last('i1').next?.title).toBe('Secret dentist');
    expect(last('i1').todos.due).toEqual([{ title: 'Private todo', list: 'week' }]);
    expect(pushedTo('i2')).toEqual([]);
    await send('calendar.day.summary', summary('u2', 'Other meeting', '2026-11-12T10:00:00.000Z'));
    expect(last('i2').next?.title).toBe('Other meeting');
    expect(JSON.stringify(pushedTo('i2'))).not.toContain('Secret dentist');
    expect(JSON.stringify(pushedTo('i2'))).not.toContain('Private todo');
    expect(JSON.stringify(pushedTo('i1'))).not.toContain('Other meeting');
  });

  test('a handler pushes only the snapshot of the user it concerns', async () => {
    const { send, pushedTo } = await setup();
    await send('calendar.day.summary', summary('u2', 'Standup'));
    expect(pushedTo('i1')).toEqual([]);
    expect(pushedTo('i2')).toHaveLength(1);
  });

  test('calendar.day.summary keeps only the last summary', async () => {
    const { send, host } = await setup();
    await send('calendar.day.summary', summary('u1', 'First'));
    await send('calendar.day.summary', summary('u1', 'Second'));
    const stored = await host.store.get<UserState>('u:u1');
    expect(stored?.calendar?.events.map((e) => e.title)).toEqual(['Second']);
  });

  test('calendar.event.upcoming reaches only the listed users and keeps the soonest event', async () => {
    const { send, last, pushedTo } = await setup();
    await send('calendar.event.upcoming', { uid: 'a', title: 'Later', start: '2026-11-12T09:30:00.000Z', minutesUntil: 120, userIds: ['u1'] });
    await send('calendar.event.upcoming', { uid: 'b', title: 'Sooner', start: '2026-11-12T08:00:00.000Z', minutesUntil: 30, userIds: ['u1'] });
    await send('calendar.event.upcoming', { uid: 'c', title: 'Latest', start: '2026-11-12T11:00:00.000Z', minutesUntil: 200, userIds: ['u1'] });
    expect(last('i1').next).toEqual({ title: 'Sooner', start: '2026-11-12T08:00:00.000Z', minutesUntil: 30 });
    expect(pushedTo('i2')).toEqual([]);
  });

  test('weather.updated is household-wide: every user gets the hint', async () => {
    const { send, last } = await setup();
    await send('weather.updated', { condition: 'storm', tempC: 12, nextPrecip: null, pollenMax: null, aqi: null });
    expect(last('i1').weatherHint).toEqual({ key: 'storm', vars: {} });
    expect(last('i2').weatherHint).toEqual({ key: 'storm', vars: {} });
  });

  test('pin.request pins for the listed users only, and the pin is gone the next day', async () => {
    const { send, last, pushedTo, host, compose } = await setup();
    await send('pin.request', { sourceKey: 'bday', title: 'Anna birthday', date: '2026-11-12', userIds: ['u1'] });
    expect(last('i1').pins).toEqual([{ key: 'bday', title: 'Anna birthday' }]);
    expect(pushedTo('i2')).toEqual([]);
    host.setNow(new Date('2026-11-12T23:30:00.000Z')); // 00:30 on the 13th in Berlin
    await compose();
    expect(last('i1').pins).toEqual([]);
    expect((await host.store.get<UserState>('u:u1'))?.pins).toEqual([]); // pruned from the store, not only hidden
  });

  test('a pin for a past or unreadable date is ignored', async () => {
    const { send, pushedTo } = await setup();
    await send('pin.request', { sourceKey: 'old', title: 'Old', date: '2026-11-11', userIds: ['u1'] });
    await send('pin.request', { sourceKey: 'bad', title: 'Bad', date: 'someday', userIds: ['u1'] });
    expect(pushedTo('i1').every((s) => s.pins.length === 0)).toBe(true);
  });

  test('notification.created keeps warn and critical for that user, ignores info', async () => {
    const { send, last, pushedTo } = await setup();
    const n = (id: string, level: 'info' | 'warn' | 'critical', userId = 'u1') => ({
      id, userId, moduleId: 'nas', level, title: `T-${id}`, createdAt: '2026-11-12T07:00:00.000Z',
    });
    await send('notification.created', n('1', 'info'));
    expect(pushedTo('i1')).toEqual([]);
    await send('notification.created', n('2', 'warn'));
    await send('notification.created', n('3', 'critical'));
    expect(last('i1').alerts).toEqual([
      { level: 'critical', title: 'T-3' },
      { level: 'warn', title: 'T-2' },
    ]);
    expect(pushedTo('i2')).toEqual([]);
  });

  test('connectivity and NAS conditions raise and clear household alerts', async () => {
    const { send, last } = await setup();
    await send('net.connectivity.changed', { online: false, since: '2026-11-12T07:00:00.000Z' });
    await send('nas.health.changed', { status: 'degraded', detail: 'disk 2 slow' });
    expect(last('i2').alerts).toEqual([
      { level: 'critical', title: '', kind: 'netOffline' },
      { level: 'warn', title: '', kind: 'nasDegraded', vars: { detail: 'disk 2 slow' } },
    ]);
    await send('net.connectivity.changed', { online: true, since: '2026-11-12T07:20:00.000Z' });
    await send('nas.health.changed', { status: 'ok', detail: '' });
    expect(last('i1').alerts).toEqual([]);
    expect(last('i2').alerts).toEqual([]);
  });

  test('the time zone of the account decides what today is', async () => {
    const { host, send, last } = await setup();
    host.setNow(new Date('2026-11-12T23:30:00.000Z')); // already the 13th in Berlin, still the 12th in UTC
    await send('calendar.day.summary', summary('u1', 'Berlin event'));
    await send('calendar.day.summary', summary('u2', 'UTC event', '2026-11-12T23:45:00.000Z'));
    expect(last('i1')).toMatchObject({ date: '2026-11-13', eventsToday: 0, next: null });
    expect(last('i2')).toMatchObject({ date: '2026-11-12', eventsToday: 1, next: { title: 'UTC event', minutesUntil: 15 } });
  });
});

describe('review fixes', () => {
  test('the NAS detail is capped at 200 characters before it is stored', async () => {
    const { send, host } = await setup();
    await send('nas.health.changed', { status: 'failed', detail: 'x'.repeat(500) });
    const g = await host.store.get<{ system: { nas: { detail: string } } }>('g');
    expect(g?.system.nas.detail).toHaveLength(200);
  });

  test('minutesUntil moving on does not raise the rev, but a snapshot is still pushed', async () => {
    const { send, host, pushedTo, compose } = await setup();
    await send('calendar.day.summary', summary('u1', 'Standup', '2026-11-12T08:30:00.000Z'));
    const first = pushedTo('i1').at(-1)!;
    host.advance(10 * 60_000);
    await compose();
    const last = pushedTo('i1').at(-1)!;
    expect(last.next?.minutesUntil).toBe(50);
    expect(last.rev).toBe(first.rev);
  });

  test('events for a user without a briefing instance store nothing', async () => {
    const { send, host, pushedTo } = await setup();
    await send('todo.day.summary', { userId: 'u3', date: '2026-11-12', overdue: 1, due: [] });
    await send('pin.request', { sourceKey: 'k', title: 'P', date: '2026-11-12', userIds: ['u3'] });
    expect(await host.store.keys()).toEqual([]);
    expect(pushedTo('i1')).toEqual([]);
  });

  test('a handler error does not block the next event for that user', async () => {
    const { send, host, last } = await setup();
    const real = host.store.set.bind(host.store);
    let fail = true;
    host.store.set = (async (key: string, value: unknown) => {
      if (fail) {
        fail = false;
        throw new Error('disk full');
      }
      return real(key, value);
    });
    await expect(send('calendar.day.summary', summary('u1', 'Lost'))).rejects.toThrow('disk full');
    await send('calendar.day.summary', summary('u1', 'Kept'));
    expect(last('i1').next?.title).toBe('Kept');
  });
});

describe('bounds and ordering', () => {
  test('stored state stays bounded: 5 alerts, bounded pins, one summary per source', async () => {
    const { send, host } = await setup();
    for (let i = 0; i < 12; i++) {
      await send('notification.created', {
        id: `n${i}`, userId: 'u1', moduleId: 'nas', level: 'warn', title: `W${i}`, createdAt: `2026-11-12T07:${String(i).padStart(2, '0')}:00.000Z`,
      });
    }
    for (let i = 0; i < MAX_PINS + 10; i++) {
      await send('pin.request', { sourceKey: `k${i}`, title: `P${i}`, date: '2026-11-12', userIds: ['u1'] });
    }
    const stored = await host.store.get<UserState>('u:u1');
    expect(stored?.alerts).toHaveLength(MAX_ALERTS);
    expect(stored?.alerts.map((a) => a.id)).toEqual(['n11', 'n10', 'n9', 'n8', 'n7']);
    expect(stored?.pins.length).toBe(MAX_PINS);
    expect(await host.store.keys()).toEqual(['u:u1', 'rev:u1']);
  });

  test('the same notification id (a deduped update) replaces its alert', async () => {
    const { send, host } = await setup();
    const n = { id: 'same', userId: 'u1', moduleId: 'nas', level: 'warn' as const, title: 'v1', createdAt: '2026-11-12T07:00:00.000Z' };
    await send('notification.created', n);
    await send('notification.created', { ...n, title: 'v2', level: 'critical' });
    expect((await host.store.get<UserState>('u:u1'))?.alerts).toEqual([{ id: 'same', level: 'critical', title: 'v2', at: n.createdAt }]);
  });

  test('rev rises with each change, an unchanged briefing is not pushed again, epoch is stable', async () => {
    const { send, pushedTo, compose } = await setup();
    await send('calendar.day.summary', summary('u1', 'A'));
    await send('calendar.day.summary', summary('u1', 'B'));
    await send('calendar.day.summary', summary('u1', 'B'));
    await compose();
    const got = pushedTo('i1');
    expect(got.map((s) => s.next?.title)).toEqual(['A', 'B']);
    expect(got.map((s) => s.rev)).toEqual([1, 2]);
    expect(new Set(got.map((s) => s.epoch)).size).toBe(1);
  });

  test('concurrent events for one user are both applied', async () => {
    const { send, host, last } = await setup();
    await Promise.all([
      send('calendar.day.summary', summary('u1', 'Standup')),
      send('todo.day.summary', { userId: 'u1', date: '2026-11-12', overdue: 1, due: [] }),
      send('pin.request', { sourceKey: 'k', title: 'Pin', date: '2026-11-12', userIds: ['u1'] }),
    ]);
    const stored = await host.store.get<UserState>('u:u1');
    expect(stored?.calendar?.events).toHaveLength(1);
    expect(stored?.todo?.overdue).toBe(1);
    expect(stored?.pins).toHaveLength(1);
    expect(last('i1')).toMatchObject({ eventsToday: 1, todos: { overdue: 1 }, pins: [{ key: 'k', title: 'Pin' }] });
    expect((last('i1').rev)).toBeGreaterThanOrEqual(1);
  });
});

describe('compose job and instances', () => {
  test('the compose job moves minutesUntil on and pushes only changed snapshots', async () => {
    const { send, host, last, pushedTo, compose } = await setup();
    await send('calendar.day.summary', summary('u1', 'Standup', '2026-11-12T08:30:00.000Z'));
    expect(last('i1').next?.minutesUntil).toBe(60);
    const before = pushedTo('i1').length;
    await compose();
    expect(pushedTo('i1')).toHaveLength(before); // nothing changed
    host.advance(10 * 60_000);
    await compose();
    expect(last('i1').next?.minutesUntil).toBe(50);
    expect(pushedTo('i2').every((x) => x.next === null)).toBe(true);
  });

  test('a new instance gets the stored briefing, a removed one drops its state', async () => {
    const { send, host, pushedTo } = await setup();
    await send('calendar.day.summary', summary('u1', 'Standup'));
    const added = inst('i3', 'u1');
    host.setInstances([inst('i1', 'u1'), inst('i2', 'u2'), added]);
    await server.onInstanceChange!('added', added, host);
    expect(pushedTo('i3').at(-1)?.next?.title).toBe('Standup');
    host.setInstances([inst('i2', 'u2')]);
    await server.onInstanceChange!('removed', inst('i1', 'u1'), host);
    await server.onInstanceChange!('removed', added, host);
    expect(await host.store.get('u:u1')).toBeUndefined();
  });

  test('setup removes the stored state of users without an instance', async () => {
    const seeded = await createMockHostWithSetup(server, {
      now: START,
      prepare: (h) => {
        h.setInstances([inst('i1', 'u1')]);
        void h.store.set('u:ghost', { pins: [], alerts: [] });
        void h.store.set('rev:ghost', 4);
        void h.store.set('u:u1', { pins: [], alerts: [] });
      },
    });
    expect((await seeded.store.keys()).sort()).toEqual(['u:u1']);
  });
});

describe('GET /day', () => {
  const sampleFor = async (host: MockHost, send: (n: 'calendar.day.summary', p: EventPayload<'calendar.day.summary'>) => Promise<void>) => {
    await send('calendar.day.summary', { ...summary('u1', 'Today thing'), events: [...summary('u1', 'Today thing').events] });
    expect(host).toBeDefined();
  };

  test('returns the caller\'s own agenda and todos, stamped, and never another user\'s', async () => {
    const { host, router, send } = await setup();
    await sampleFor(host, send);
    await send('todo.day.summary', { userId: 'u1', date: '2026-11-12', overdue: 0, due: [{ id: 't', title: 'Milk', list: 'shopping' }] });
    const mine = await router.call('GET', '/day', { level: 'view', user: { id: 'u1' } });
    expect(mine.status).toBe(200);
    const body = mine.body as DayDetail;
    expect(body.date).toBe('2026-11-12');
    expect(body.today.map((e) => e.title)).toEqual(['Today thing']);
    expect(body.todos.due).toEqual([{ title: 'Milk', list: 'shopping' }]);
    expect(body.epoch).toBeTruthy();
    expect(body.rev).toBeGreaterThanOrEqual(1);
    const other = (await router.call('GET', '/day', { level: 'view', user: { id: 'u2' } })).body as DayDetail;
    expect(other.today).toEqual([]);
    expect(other.todos).toEqual({ due: [], overdue: 0 });
  });

  test('a view-level request is allowed and an empty briefing answers with empty sections', async () => {
    const { router } = await setup();
    const res = await router.call('GET', '/day', { level: 'view', user: { id: 'u2' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ date: '2026-11-12', today: [], tomorrow: [], alerts: [] });
  });
});
