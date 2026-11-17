import { describe, expect, test } from 'vitest';
import type { ModuleInstance } from '@dash/contract';
import { applyMigrations, createMockHost, createMockRouter, runServerContractSuite } from '@dash/module-kit/testing';
import server from '../server/index.js';
import { createTimer, dueTimers, listTimers, markFired } from '../server/timers.js';
import type { Snapshot } from '../manifest.js';

runServerContractSuite(server, { moduleDir: import.meta.dirname + '/..' });

const START = new Date('2026-01-01T12:00:00.000Z');
const inst = (id: string, ownerId: string): ModuleInstance => ({ id, ownerId, pageId: 'p1', settings: {} });

function setup() {
  const host = createMockHost(server.manifest, { now: START });
  applyMigrations(host, server.migrations ?? []);
  host.setInstances([inst('i1', 'u1'), inst('i2', 'u2'), inst('i3', 'u1')]);
  const router = createMockRouter(server, host);
  const tick = () => server.jobs!['tick']!({ host, instance: null, signal: new AbortController().signal });
  const pushedTo = (id: string) => host.pushed.filter((p) => p.instanceId === id);
  return { host, router, tick, pushedTo, db: host.store.db };
}

describe('timers logic', () => {
  test('createTimer rejects 0 and 86401', () => {
    const { db } = setup();
    expect(() => createTimer(db, 'u1', { label: 'x', durationSec: 0 }, START)).toThrowError(/invalid/);
    expect(() => createTimer(db, 'u1', { label: 'x', durationSec: 86_401 }, START)).toThrowError(/invalid/);
    expect(() => createTimer(db, 'u1', { label: 'x', durationSec: 1.5 }, START)).toThrowError(/invalid/);
    expect(() => createTimer(db, 'u1', { label: 'x'.repeat(41), durationSec: 5 }, START)).toThrowError(/invalid/);
    expect(createTimer(db, 'u1', { label: ' tea ', durationSec: 86_400 }, START)).toMatchObject({
      label: 'tea',
      endsAt: '2026-01-02T12:00:00.000Z',
      fired: false,
    });
  });

  test('dueTimers returns only unfired past timers', () => {
    const { db } = setup();
    const past = createTimer(db, 'u1', { label: 'past', durationSec: 10 }, START);
    const fired = createTimer(db, 'u1', { label: 'fired', durationSec: 10 }, START);
    createTimer(db, 'u1', { label: 'future', durationSec: 100 }, START);
    markFired(db, fired.id);
    const now = new Date(START.getTime() + 10_000); // ends_at <= now is due
    expect(dueTimers(db, now).map((t) => t.id)).toEqual([past.id]);
    expect(dueTimers(db, START)).toEqual([]);
  });

  test('listTimers is the active timers of one owner ordered by end', () => {
    const { db } = setup();
    const late = createTimer(db, 'u1', { label: 'late', durationSec: 300 }, START);
    const soon = createTimer(db, 'u1', { label: 'soon', durationSec: 60 }, START);
    createTimer(db, 'u2', { label: 'other', durationSec: 60 }, START);
    createTimer(db, 'u1', { label: 'over', durationSec: 5 }, START);
    const now = new Date(START.getTime() + 10_000);
    expect(listTimers(db, 'u1', now).map((t) => t.id)).toEqual([soon.id, late.id]);
  });
});

describe('tick job', () => {
  test('tick publishes timer.finished once per timer and notifies its owner', async () => {
    const { host, db, tick } = setup();
    const t = createTimer(db, 'u2', { label: 'Pasta', durationSec: 30 }, START);
    createTimer(db, 'u1', { label: '', durationSec: 60 }, START);
    host.advance(30_000);
    await tick();
    await tick();
    expect(host.published).toEqual([{ name: 'timer.finished', payload: { id: t.id, label: 'Pasta' } }]);
    expect(host.notified).toEqual([{ level: 'info', title: 'Pasta', userIds: ['u2'], dedupeKey: `timer:${t.id}` }]);
  });

  test('an unlabelled timer notifies with a default title', async () => {
    const { host, db, tick } = setup();
    createTimer(db, 'u1', { label: '', durationSec: 5 }, START);
    host.advance(5_000);
    await tick();
    expect(host.notified[0]?.title).toBe('Timer finished');
  });

  test('a firing timer drops out of its owner snapshots only', async () => {
    const { host, db, tick, pushedTo } = setup();
    createTimer(db, 'u1', { label: 'a', durationSec: 5 }, START);
    await tick(); // startup push
    host.pushed.length = 0;
    host.advance(5_000);
    await tick();
    expect(pushedTo('i1')).toHaveLength(1);
    expect(pushedTo('i3')).toHaveLength(1);
    expect((pushedTo('i1')[0]!.data as Snapshot).timers).toEqual([]);
    expect(pushedTo('i2')).toHaveLength(0); // u2 unchanged
  });

  test('first tick pushes every instance once, a tick with nothing due pushes nothing', async () => {
    const { host, tick } = setup();
    await tick();
    expect(host.pushed.map((p) => p.instanceId).sort()).toEqual(['i1', 'i2', 'i3']);
    host.pushed.length = 0;
    host.advance(5_000);
    await tick();
    await tick();
    expect(host.pushed).toEqual([]);
    expect(host.published).toEqual([]);
  });

  test('a past nextEvent is cleared at the next tick', async () => {
    const { host, tick, pushedTo } = setup();
    await server.on!['calendar.event.upcoming']!(
      { uid: 'e', title: 'Dentist', start: '2026-01-01T12:10:00.000Z', minutesUntil: 10, userIds: ['u1'] },
      host,
    );
    await tick();
    host.pushed.length = 0;
    host.advance(11 * 60_000);
    await tick();
    expect(await host.store.get('next:u1')).toBeUndefined();
    expect((pushedTo('i1')[0]!.data as Snapshot).nextEvent).toBeNull();
    expect(pushedTo('i1')).toHaveLength(1);
  });
});

describe('calendar.event.upcoming', () => {
  const upcoming = (title: string, start: string, userIds: string[]) => ({ uid: title, title, start, minutesUntil: 5, userIds });

  test('calendar.event.upcoming stores nextEvent per user and pushes it only to that user\'s instances', async () => {
    const { host, pushedTo } = setup();
    await server.on!['calendar.event.upcoming']!(upcoming('Dentist', '2026-01-01T12:30:00.000Z', ['u1']), host);
    expect(await host.store.get('next:u1')).toEqual({ title: 'Dentist', start: '2026-01-01T12:30:00.000Z' });
    expect(await host.store.get('next:u2')).toBeUndefined();
    expect(pushedTo('i1').map((p) => (p.data as Snapshot).nextEvent)).toEqual([
      { title: 'Dentist', start: '2026-01-01T12:30:00.000Z' },
    ]);
    expect(pushedTo('i3')).toHaveLength(1);
    expect(pushedTo('i2')).toHaveLength(0);
  });

  test('keeps the soonest upcoming event', async () => {
    const { host } = setup();
    const on = server.on!['calendar.event.upcoming']!;
    await on(upcoming('Later', '2026-01-01T14:00:00.000Z', ['u1']), host);
    await on(upcoming('Sooner', '2026-01-01T13:00:00.000Z', ['u1']), host);
    await on(upcoming('Latest', '2026-01-01T15:00:00.000Z', ['u1']), host);
    expect(await host.store.get('next:u1')).toEqual({ title: 'Sooner', start: '2026-01-01T13:00:00.000Z' });
    host.advance(2 * 3_600_000); // Sooner has passed
    await on(upcoming('Latest', '2026-01-01T15:00:00.000Z', ['u1']), host);
    expect(await host.store.get('next:u1')).toEqual({ title: 'Latest', start: '2026-01-01T15:00:00.000Z' });
  });

  test('ignores events already started and unparsable starts', async () => {
    const { host } = setup();
    const on = server.on!['calendar.event.upcoming']!;
    await on(upcoming('Past', '2026-01-01T11:00:00.000Z', ['u1']), host);
    await on(upcoming('Junk', 'soon', ['u1']), host);
    expect(await host.store.keys('next:')).toEqual([]);
    expect(host.pushed).toEqual([]);
  });
});

describe('onInstanceChange', () => {
  test('added pushes the new instance snapshot immediately', async () => {
    const { host, db } = setup();
    createTimer(db, 'u1', { label: 'tea', durationSec: 60 }, START);
    await server.onInstanceChange!('added', inst('i9', 'u1'), host);
    expect(host.pushed).toHaveLength(1);
    expect(host.pushed[0]).toMatchObject({ instanceId: 'i9', data: { timers: [{ label: 'tea', durationSec: 60 }], nextEvent: null } });
  });
});

describe('routes', () => {
  test('GET /timers returns only the caller\'s active timers', async () => {
    const { router, db } = setup();
    createTimer(db, 'u1', { label: 'mine', durationSec: 60 }, START);
    createTimer(db, 'u2', { label: 'theirs', durationSec: 60 }, START);
    const res = await router.call('GET', '/timers', { level: 'view' });
    expect(res.status).toBe(200);
    expect((res.body as Snapshot["timers"]).map((t) => ({ label: t.label, endsAt: t.endsAt, durationSec: t.durationSec }))).toEqual([
      { label: 'mine', endsAt: '2026-01-01T12:01:00.000Z', durationSec: 60 },
    ]);
  });

  test('POST creates and pushes updated snapshot', async () => {
    const { host, router, pushedTo } = setup();
    const res = await router.call('POST', '/timers', { level: 'edit', body: { label: 'Eggs', durationSec: 420 } });
    expect(res.status).toBe(200);
    const created = res.body as { id: string };
    expect(res.body).toMatchObject({ label: 'Eggs', durationSec: 420, endsAt: '2026-01-01T12:07:00.000Z' });
    for (const id of ['i1', 'i3']) {
      expect(pushedTo(id).map((p) => (p.data as Snapshot).timers.map((t) => t.id))).toEqual([[created.id]]);
    }
    expect(pushedTo('i2')).toHaveLength(0);
    expect(host.pushed).toHaveLength(2);
  });

  test('POST rejects a label over 40 characters and a bad duration with 422', async () => {
    const { host, router } = setup();
    const long = await router.call('POST', '/timers', { level: 'edit', body: { label: 'x'.repeat(41), durationSec: 5 } });
    const zero = await router.call('POST', '/timers', { level: 'edit', body: { label: 'x', durationSec: 0 } });
    const nan = await router.call('POST', '/timers', { level: 'edit', body: { label: 'x' } });
    expect([long.status, zero.status, nan.status]).toEqual([422, 422, 422]);
    expect(host.pushed).toEqual([]);
  });

  test('view level POST → 403', async () => {
    const { host, router } = setup();
    const res = await router.call('POST', '/timers', { level: 'view', body: { label: 'x', durationSec: 5 } });
    expect(res.status).toBe(403);
    expect(listTimers(host.store.db, 'u1', START)).toEqual([]);
  });

  test('DELETE removes the caller\'s timer and pushes', async () => {
    const { host, router, db } = setup();
    const t = createTimer(db, 'u1', { label: 'mine', durationSec: 60 }, START);
    const res = await router.call('DELETE', `/timers/${t.id}`, { level: 'edit' });
    expect(res.status).toBe(200); // the real router turns undefined into 204
    expect(res.body).toBeUndefined();
    expect(listTimers(db, 'u1', START)).toEqual([]);
    expect(host.pushed.map((p) => p.instanceId).sort()).toEqual(['i1', 'i3']);
  });

  test('DELETE of another user\'s timer → 404', async () => {
    const { host, router, db } = setup();
    const t = createTimer(db, 'u2', { label: 'theirs', durationSec: 60 }, START);
    const res = await router.call('DELETE', `/timers/${t.id}`, { level: 'edit', user: { id: 'u1' } });
    expect(res.status).toBe(404);
    expect(listTimers(db, 'u2', START)).toHaveLength(1);
    expect((await router.call('DELETE', '/timers/nope', { level: 'edit' })).status).toBe(404);
    expect(host.pushed).toEqual([]);
  });
});

describe('zones routes', () => {
  test('GET /zones is empty by default, per user', async () => {
    const { router } = setup();
    expect(await router.call('GET', '/zones', { level: 'view' })).toEqual({ status: 200, body: [] });
  });

  test('PUT /zones stores the list for the caller only', async () => {
    const { router } = setup();
    const put = await router.call('PUT', '/zones', { level: 'edit', body: { zones: ['Europe/Berlin', 'UTC'] } });
    expect(put).toEqual({ status: 200, body: ['Europe/Berlin', 'UTC'] });
    expect((await router.call('GET', '/zones', { level: 'view' })).body).toEqual(['Europe/Berlin', 'UTC']);
    expect((await router.call('GET', '/zones', { level: 'view', user: { id: 'u2' } })).body).toEqual([]);
  });

  test('PUT /zones dedupes and keeps order', async () => {
    const { router } = setup();
    const put = await router.call('PUT', '/zones', {
      level: 'edit',
      body: { zones: ['Asia/Tokyo', 'UTC', 'Asia/Tokyo'] },
    });
    expect(put.body).toEqual(['Asia/Tokyo', 'UTC']);
  });

  test('invalid zone rejected with 422', async () => {
    const { router } = setup();
    const res = await router.call('PUT', '/zones', { level: 'edit', body: { zones: ['Europe/Berlin', 'Mars/Base'] } });
    expect(res.status).toBe(422);
    expect((await router.call('GET', '/zones', { level: 'view' })).body).toEqual([]);
  });

  test('PUT /zones accepts 12 entries and rejects 13 with 422', async () => {
    const { router } = setup();
    const all = Intl.supportedValuesOf('timeZone');
    expect((await router.call('PUT', '/zones', { level: 'edit', body: { zones: all.slice(0, 12) } })).status).toBe(200);
    expect((await router.call('PUT', '/zones', { level: 'edit', body: { zones: all.slice(0, 13) } })).status).toBe(422);
  });

  test('PUT /zones needs level edit', async () => {
    const { router } = setup();
    expect((await router.call('PUT', '/zones', { level: 'view', body: { zones: [] } })).status).toBe(403);
  });
});
