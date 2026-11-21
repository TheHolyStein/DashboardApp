import { describe, expect, test, vi } from 'vitest';
import type { ModuleInstance } from '@dash/contract';
import { createMockHostWithSetup, createMockRouter, runServerContractSuite } from '@dash/module-kit/testing';
import server from '../server/index.js';
import { MAX_ACTIVE, createTimer, dueTimers, listTimers, markFired, purgeFired } from '../server/timers.js';
import type { Snapshot, TimerList } from '../manifest.js';

runServerContractSuite(server, { moduleDir: import.meta.dirname + '/..' });

const START = new Date('2026-01-01T12:00:00.000Z');
const inst = (id: string, ownerId: string): ModuleInstance => ({ id, ownerId, pageId: 'p1', settings: {} });

async function setup() {
  const host = await createMockHostWithSetup(server, {
    now: START,
    prepare: (h) => h.setInstances([inst('i1', 'u1'), inst('i2', 'u2'), inst('i3', 'u1')]),
  });
  const router = createMockRouter(server, host);
  const tick = () => server.jobs!['tick']!({ host, instance: null, signal: new AbortController().signal });
  const pushedTo = (id: string) => host.pushed.filter((p) => p.instanceId === id);
  return { host, router, tick, pushedTo, db: host.store.db };
}

describe('timers logic', () => {
  test('createTimer rejects 0 and 86401', async () => {
    const { db } = await setup();
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

  test('dueTimers returns only unfired past timers', async () => {
    const { db } = await setup();
    const past = createTimer(db, 'u1', { label: 'past', durationSec: 10 }, START);
    const fired = createTimer(db, 'u1', { label: 'fired', durationSec: 10 }, START);
    createTimer(db, 'u1', { label: 'future', durationSec: 100 }, START);
    markFired(db, fired.id);
    const now = new Date(START.getTime() + 10_000); // ends_at <= now is due
    expect(dueTimers(db, now).map((t) => t.id)).toEqual([past.id]);
    expect(dueTimers(db, START)).toEqual([]);
  });

  test('listTimers is the active timers of one owner ordered by end', async () => {
    const { db } = await setup();
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
    const { host, db, tick } = await setup();
    const t = createTimer(db, 'u2', { label: 'Pasta', durationSec: 30 }, START);
    createTimer(db, 'u1', { label: '', durationSec: 60 }, START);
    host.advance(30_000);
    await tick();
    await tick();
    expect(host.published).toEqual([{ name: 'timer.finished', payload: { id: t.id, label: 'Pasta' } }]);
    expect(host.notified).toEqual([
      {
        level: 'info',
        title: 'Pasta',
        titleKey: 'm.clock.notify.finished',
        vars: { label: 'Pasta' },
        userIds: ['u2'],
        dedupeKey: `timer:${t.id}`,
      },
    ]);
  });

  test('an unlabelled timer notifies with a default title', async () => {
    const { host, db, tick } = await setup();
    createTimer(db, 'u1', { label: '', durationSec: 5 }, START);
    host.advance(5_000);
    await tick();
    expect(host.notified[0]?.title).toBe('Timer finished');
  });

  test('a firing timer drops out of its owner snapshots only', async () => {
    const { host, db, tick, pushedTo } = await setup();
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
    const { host, tick } = await setup();
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
    const { host, tick, pushedTo } = await setup();
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
    const { host, pushedTo } = await setup();
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
    const { host } = await setup();
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
    const { host } = await setup();
    const on = server.on!['calendar.event.upcoming']!;
    await on(upcoming('Past', '2026-01-01T11:00:00.000Z', ['u1']), host);
    await on(upcoming('Junk', 'soon', ['u1']), host);
    expect(await host.store.keys('next:')).toEqual([]);
    expect(host.pushed).toEqual([]);
  });
});

describe('onInstanceChange', () => {
  test('added pushes the new instance snapshot immediately', async () => {
    const { host, db } = await setup();
    createTimer(db, 'u1', { label: 'tea', durationSec: 60 }, START);
    host.setInstances([inst('i9', 'u1')]); // the host lists an instance by the time it reports it added
    await server.onInstanceChange!('added', inst('i9', 'u1'), host);
    expect(host.pushed).toHaveLength(1);
    expect(host.pushed[0]).toMatchObject({ instanceId: 'i9', data: { timers: [{ label: 'tea', durationSec: 60 }], nextEvent: null } });
  });
});

describe('tick hardening', () => {
  test('a removed instance is forgotten: no push while gone, a fresh push when it returns', async () => {
    const { host, router, tick, pushedTo } = await setup();
    await tick();
    host.pushed.length = 0;
    host.setInstances([inst('i2', 'u2'), inst('i3', 'u1')]); // i1 removed
    await server.onInstanceChange!('removed', inst('i1', 'u1'), host);
    const res = await router.call('POST', '/timers', { level: 'edit', body: { label: 'x', durationSec: 60 } });
    expect(res.status).toBe(200);
    expect(pushedTo('i1')).toHaveLength(0);
    expect(pushedTo('i3')).toHaveLength(1);
    host.pushed.length = 0;
    host.setInstances([inst('i1', 'u1'), inst('i2', 'u2'), inst('i3', 'u1')]);
    await server.onInstanceChange!('added', inst('i1', 'u1'), host);
    expect(pushedTo('i1')).toHaveLength(1); // same content as before, but forgotten
  });

  test('an instance removed while the tick builds snapshots is not pushed', async () => {
    const { host, db, tick, pushedTo } = await setup();
    createTimer(db, 'u1', { label: 'a', durationSec: 5 }, START);
    await tick();
    host.pushed.length = 0;
    host.advance(5_000);
    const real = host.instances.bind(host);
    let calls = 0;
    host.instances = async <S>() => {
      calls++;
      const list = await real<S>();
      return calls === 1 ? list : list.filter((i) => i.id !== 'i1'); // gone by the membership re-check
    };
    await tick();
    expect(pushedTo('i1')).toHaveLength(0);
    expect(pushedTo('i3')).toHaveLength(1);
  });

  test('calendar.event.upcoming for two users pushes each user\'s instances separately and nothing to a third', async () => {
    const { host, pushedTo } = await setup();
    host.setInstances([inst('i1', 'u1'), inst('i2', 'u2'), inst('i3', 'u1'), inst('i4', 'u3')]);
    const on = server.on!['calendar.event.upcoming']!;
    await on({ uid: 'a', title: 'A', start: '2026-01-01T12:30:00.000Z', minutesUntil: 30, userIds: ['u1'] }, host);
    await on({ uid: 'b', title: 'B', start: '2026-01-01T12:40:00.000Z', minutesUntil: 40, userIds: ['u2'] }, host);
    expect(pushedTo('i1').map((p) => (p.data as Snapshot).nextEvent?.title)).toEqual(['A']);
    expect(pushedTo('i3').map((p) => (p.data as Snapshot).nextEvent?.title)).toEqual(['A']);
    expect(pushedTo('i2').map((p) => (p.data as Snapshot).nextEvent?.title)).toEqual(['B']);
    expect(pushedTo('i4')).toHaveLength(0);
  });

  test('the 51st running timer of one owner is refused with a clear message; others are unaffected', async () => {
    const { router, db } = await setup();
    for (let i = 0; i < MAX_ACTIVE; i++) createTimer(db, 'u1', { label: `t${i}`, durationSec: 600 }, START);
    const res = await router.call('POST', '/timers', { level: 'edit', body: { label: 'one too many', durationSec: 60 } });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('at most 50');
    expect((await router.call('POST', '/timers', { level: 'edit', user: { id: 'u2' }, body: { label: 'ok', durationSec: 60 } })).status).toBe(200);
  });

  test('fired rows older than a day are purged by tick, at most once an hour', async () => {
    const { host, db, tick } = await setup();
    const old = createTimer(db, 'u1', { label: 'old', durationSec: 5 }, START);
    markFired(db, old.id);
    const count = () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM m_clock_timers')!.n;
    await tick(); // first tick purges, but the row is not a day old yet
    expect(count()).toBe(1);
    host.advance(86_400_000 + 10_000);
    await tick(); // an hour has passed since the last purge: runs
    expect(count()).toBe(0);
    const again = createTimer(db, 'u1', { label: 'again', durationSec: 5 }, new Date(host.now().getTime() - 86_400_000));
    markFired(db, again.id);
    host.advance(600_000);
    await tick(); // 10 minutes after the last purge: skipped
    expect(count()).toBe(1);
    host.advance(3_000_000);
    await tick();
    expect(count()).toBe(0);
    expect(purgeFired(db, host.now())).toBe(0);
  });

  test('a publish that throws for one timer does not stop the next timer from firing', async () => {
    const { host, db, tick, pushedTo } = await setup();
    const a = createTimer(db, 'u1', { label: 'a', durationSec: 5 }, START);
    const b = createTimer(db, 'u2', { label: 'b', durationSec: 6 }, START);
    await tick();
    host.pushed.length = 0;
    const publish = host.bus.publish.bind(host.bus);
    host.bus.publish = ((name: string, payload: { id?: string }) => {
      if (payload.id === a.id) throw new Error('bus down');
      return (publish as (n: string, p: unknown) => void)(name, payload);
    }) as typeof host.bus.publish;
    const error = vi.spyOn(host.log, 'error');
    host.advance(10_000);
    await tick();
    expect(error).toHaveBeenCalledOnce();
    expect(host.published.map((p) => (p.payload as { id: string }).id)).toEqual([b.id]);
    expect(host.notified.map((n) => n.dedupeKey)).toEqual([`timer:${a.id}`, `timer:${b.id}`]);
    expect(pushedTo('i1')).toHaveLength(1); // dirty was set before the failure
    await tick();
    expect(host.notified).toHaveLength(2); // both are marked fired: nothing fires twice
  });

  test('an idle tick makes no instances() call and no kv scan', async () => {
    const { host, tick } = await setup();
    await tick();
    const instances = vi.spyOn(host, 'instances');
    const keys = vi.spyOn(host.store, 'keys');
    host.advance(5_000);
    await tick();
    await tick();
    expect(instances).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
  });
});

describe('next-event flag and startup', () => {
  const upcoming = (title: string, start: string, userIds: string[]) => ({ uid: title, title, start, minutesUntil: 5, userIds });

  test('a stored next: key at startup is rebuilt by the first tick and later expired', async () => {
    const { host, tick } = await setup();
    await host.store.set('next:u1', { title: 'Old', start: '2026-01-01T12:10:00.000Z' });
    await tick(); // hasNext was unknown: the scan finds the key
    host.advance(11 * 60_000);
    await tick();
    expect(await host.store.get('next:u1')).toBeUndefined();
  });

  test('an event arriving between idle ticks is expired by a later tick', async () => {
    const { host, tick } = await setup();
    await tick();
    host.advance(5_000);
    await tick(); // idle
    await server.on!['calendar.event.upcoming']!(upcoming('Dentist', '2026-01-01T12:10:00.000Z', ['u1']), host);
    host.advance(11 * 60_000);
    await tick();
    expect(await host.store.get('next:u1')).toBeUndefined();
  });

  test('a handler write during a tick scan is not lost', async () => {
    const { host, tick } = await setup();
    await server.on!['calendar.event.upcoming']!(upcoming('First', '2026-01-01T12:10:00.000Z', ['u1']), host);
    await tick();
    host.advance(11 * 60_000); // First has started; the next tick deletes it
    const realGet = host.store.get.bind(host.store);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    host.store.get = async <T>(key: string) => {
      if (first && key === 'next:u1') {
        first = false;
        await gate; // the scan is parked on its first read
      }
      return realGet<T>(key);
    };
    const running = tick();
    await vi.waitFor(() => expect(first).toBe(false)); // the scan is parked
    await server.on!['calendar.event.upcoming']!(upcoming('Second', '2026-01-01T12:40:00.000Z', ['u2']), host);
    release();
    await running;
    host.store.get = realGet;
    expect(await host.store.get('next:u1')).toBeUndefined();
    host.advance(30 * 60_000); // Second has started: only a flag that survived the scan lets this tick expire it
    await tick();
    expect(await host.store.get('next:u2')).toBeUndefined();
  });

  test('a failed startup push is retried: the module is not started until a push succeeded', async () => {
    const { host, tick } = await setup();
    const real = host.instances.bind(host);
    let fail = true;
    host.instances = async <S>() => {
      if (fail) throw new Error('db busy');
      return real<S>();
    };
    await expect(tick()).rejects.toThrow('db busy');
    fail = false;
    await tick();
    expect(host.pushed.map((p) => p.instanceId).sort()).toEqual(['i1', 'i2', 'i3']);
  });

  test('a purge failure is logged and does not stop due timers', async () => {
    const { host, db, tick } = await setup();
    createTimer(db, 'u1', { label: 'a', durationSec: 5 }, START);
    const real = db.run.bind(db);
    vi.spyOn(db, 'run').mockImplementation((sql: string, params?: unknown[]) => {
      if (sql.startsWith('DELETE')) throw new Error('disk full');
      return real(sql, params);
    });
    const error = vi.spyOn(host.log, 'error');
    host.advance(5_000);
    await tick();
    expect(error).toHaveBeenCalledWith('clock: purging fired timers failed', expect.anything());
    expect(host.notified).toHaveLength(1);
  });
});

describe('routes', () => {
  test('GET /timers returns only the caller\'s active timers', async () => {
    const { router, db } = await setup();
    createTimer(db, 'u1', { label: 'mine', durationSec: 60 }, START);
    createTimer(db, 'u2', { label: 'theirs', durationSec: 60 }, START);
    const res = await router.call('GET', '/timers', { level: 'view' });
    expect(res.status).toBe(200);
    const body = res.body as TimerList;
    expect(body.timers.map((t) => ({ label: t.label, endsAt: t.endsAt, durationSec: t.durationSec }))).toEqual([
      { label: 'mine', endsAt: '2026-01-01T12:01:00.000Z', durationSec: 60 },
    ]);
    expect(body.rev).toBe(0); // nothing changed through the module yet
  });

  test('POST creates and pushes updated snapshot', async () => {
    const { host, router, pushedTo } = await setup();
    const res = await router.call('POST', '/timers', { level: 'edit', body: { label: 'Eggs', durationSec: 420 } });
    expect(res.status).toBe(200);
    const { rev, timers } = res.body as TimerList;
    const created = timers[0]!;
    expect(timers).toHaveLength(1);
    expect(created).toMatchObject({ label: 'Eggs', durationSec: 420, endsAt: '2026-01-01T12:07:00.000Z' });
    expect(rev).toBe(1);
    expect(pushedTo('i1').map((p) => (p.data as Snapshot).rev)).toEqual([1]);
    for (const id of ['i1', 'i3']) {
      expect(pushedTo(id).map((p) => (p.data as Snapshot).timers.map((t) => t.id))).toEqual([[created.id]]);
    }
    expect(pushedTo('i2')).toHaveLength(0);
    expect(host.pushed).toHaveLength(2);
  });

  test('POST rejects a label over 40 characters and a bad duration with 422', async () => {
    const { host, router } = await setup();
    const long = await router.call('POST', '/timers', { level: 'edit', body: { label: 'x'.repeat(41), durationSec: 5 } });
    const zero = await router.call('POST', '/timers', { level: 'edit', body: { label: 'x', durationSec: 0 } });
    const nan = await router.call('POST', '/timers', { level: 'edit', body: { label: 'x' } });
    expect([long.status, zero.status, nan.status]).toEqual([422, 422, 422]);
    expect(host.pushed).toEqual([]);
  });

  test('view level POST → 403', async () => {
    const { host, router } = await setup();
    const res = await router.call('POST', '/timers', { level: 'view', body: { label: 'x', durationSec: 5 } });
    expect(res.status).toBe(403);
    expect(listTimers(host.store.db, 'u1', START)).toEqual([]);
  });

  test('DELETE removes the caller\'s timer and pushes', async () => {
    const { host, router, db } = await setup();
    const t = createTimer(db, 'u1', { label: 'mine', durationSec: 60 }, START);
    const res = await router.call('DELETE', `/timers/${t.id}`, { level: 'edit' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rev: 1, timers: [] }); // the caller's full current list, not 204
    expect(listTimers(db, 'u1', START)).toEqual([]);
    expect(host.pushed.map((p) => p.instanceId).sort()).toEqual(['i1', 'i3']);
  });

  test('DELETE of another user\'s timer → 404', async () => {
    const { host, router, db } = await setup();
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
    const { router } = await setup();
    expect(await router.call('GET', '/zones', { level: 'view' })).toEqual({ status: 200, body: [] });
  });

  test('PUT /zones stores the list for the caller only', async () => {
    const { router } = await setup();
    const put = await router.call('PUT', '/zones', { level: 'edit', body: { zones: ['Europe/Berlin', 'UTC'] } });
    expect(put).toEqual({ status: 200, body: ['Europe/Berlin', 'UTC'] });
    expect((await router.call('GET', '/zones', { level: 'view' })).body).toEqual(['Europe/Berlin', 'UTC']);
    expect((await router.call('GET', '/zones', { level: 'view', user: { id: 'u2' } })).body).toEqual([]);
  });

  test('PUT /zones dedupes and keeps order', async () => {
    const { router } = await setup();
    const put = await router.call('PUT', '/zones', {
      level: 'edit',
      body: { zones: ['Asia/Tokyo', 'UTC', 'Asia/Tokyo'] },
    });
    expect(put.body).toEqual(['Asia/Tokyo', 'UTC']);
  });

  test('invalid zone rejected with 422', async () => {
    const { router } = await setup();
    const res = await router.call('PUT', '/zones', { level: 'edit', body: { zones: ['Europe/Berlin', 'Mars/Base'] } });
    expect(res.status).toBe(422);
    expect((await router.call('GET', '/zones', { level: 'view' })).body).toEqual([]);
  });

  test('PUT /zones accepts 12 entries and rejects 13 with 422', async () => {
    const { router } = await setup();
    const all = Intl.supportedValuesOf('timeZone');
    expect((await router.call('PUT', '/zones', { level: 'edit', body: { zones: all.slice(0, 12) } })).status).toBe(200);
    expect((await router.call('PUT', '/zones', { level: 'edit', body: { zones: all.slice(0, 13) } })).status).toBe(422);
  });

  test('PUT /zones needs level edit', async () => {
    const { router } = await setup();
    expect((await router.call('PUT', '/zones', { level: 'view', body: { zones: [] } })).status).toBe(403);
  });
});

describe('revision ordering', () => {
  const body = async (router: Awaited<ReturnType<typeof setup>>['router'], method: string, path: string, req: Parameters<typeof router.call>[2]) =>
    (await router.call(method, path, req)).body as TimerList;

  test('every create, delete and fire raises the owner rev; other owners are untouched', async () => {
    const { host, router, tick } = await setup();
    const a = await body(router, 'POST', '/timers', { level: 'edit', body: { label: 'a', durationSec: 60 } });
    const b = await body(router, 'POST', '/timers', { level: 'edit', body: { label: 'b', durationSec: 5 } });
    expect([a.rev, b.rev]).toEqual([1, 2]);
    const del = await body(router, 'DELETE', `/timers/${a.timers[0]!.id}`, { level: 'edit' });
    expect(del.rev).toBe(3);
    expect(del.timers.map((t) => t.label)).toEqual(['b']);
    host.advance(5_000);
    await tick(); // b fires
    const after = await body(router, 'GET', '/timers', { level: 'view' });
    expect(after).toEqual({ rev: 4, timers: [] });
    expect((await body(router, 'GET', '/timers', { level: 'view', user: { id: 'u2' } })).rev).toBe(0);
  });

  test('a GET is stamped with the rev of the list it carries', async () => {
    const { router } = await setup();
    const created = await body(router, 'POST', '/timers', { level: 'edit', body: { label: 'a', durationSec: 60 } });
    expect(await body(router, 'GET', '/timers', { level: 'view' })).toEqual(created);
  });

  test('a next event raises the owner rev and the pushed snapshot carries it', async () => {
    const { host, pushedTo } = await setup();
    await server.on!['calendar.event.upcoming']!(
      { uid: 'e', title: 'Dentist', start: '2026-01-01T12:30:00.000Z', minutesUntil: 30, userIds: ['u1'] },
      host,
    );
    expect((pushedTo('i1')[0]!.data as Snapshot).rev).toBe(1);
  });

  test('rev survives a restart: a new setup over the same store continues above the old value', async () => {
    const { host, router } = await setup();
    await router.call('POST', '/timers', { level: 'edit', body: { label: 'a', durationSec: 60 } });
    const last = await body(router, 'POST', '/timers', { level: 'edit', body: { label: 'b', durationSec: 60 } });
    expect(last.rev).toBe(2);
    await server.setup!(host); // restart: the in-memory counters are gone, the store stays
    const next = await body(router, 'POST', '/timers', { level: 'edit', body: { label: 'c', durationSec: 60 } });
    expect(next.rev).toBe(3);
    expect(await host.store.get('rev:u1')).toBe(3);
  });
});
