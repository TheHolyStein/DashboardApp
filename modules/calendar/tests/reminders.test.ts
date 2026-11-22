import { describe, expect, it } from 'vitest';
import type { ModuleInstance } from '@dash/contract';
import type { MockHost } from '@dash/module-kit/testing';
import server from '../server/index.js';
import type { Snapshot } from '../server/reminders.js';
import { create, personal, setup, share } from './api-helpers.js';

const tick = (host: MockHost) => server.jobs!['reminders']!({ host, instance: null, signal: new AbortController().signal });
const named = (host: MockHost, name: string) => host.published.filter((p) => p.name === name).map((p) => p.payload as Record<string, unknown>);

// NOW = Mon 2027-01-04 08:00Z = 09:00 Berlin. Events created in Europe/Berlin wall time.
const at = (hhmm: string, day = '2027-01-04') => ({ start: `${day}T${hhmm}:00`, end: `${day}T${hhmm.slice(0, 2)}:59:00` });

describe('reminders', () => {
  it('reminder fires once', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u1');
    await create(router, 'u1', { calendarId: cal, title: 'Call !remind 30m @eli', ...at('10:00') }); // fires 09:30Z
    host.setNow(new Date('2027-01-04T08:29:00Z'));
    await tick(host);
    expect(host.notified).toHaveLength(0);
    host.setNow(new Date('2027-01-04T08:30:10Z'));
    await tick(host);
    await tick(host);
    expect(host.notified).toHaveLength(1);
    expect(host.notified[0]).toMatchObject({ level: 'info', title: 'Call @eli', userIds: ['u1', 'u2'], vars: { minutes: 30 } });
    expect(host.notified[0]!.dedupeKey).toMatch(/^calendar:.*:single:remind:/);
  });

  it('missed reminders older than 6 h are dropped silently after downtime, newer ones fire late', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u1');
    await create(router, 'u1', { calendarId: cal, title: 'Early !remind 1h', ...at('10:00') }); // fires 08:00Z
    await create(router, 'u1', { calendarId: cal, title: 'Late !remind 1h', ...at('16:00') }); // fires 14:00Z
    host.setNow(new Date('2027-01-04T15:00:00Z')); // server was down from 08:00Z until now
    await tick(host);
    expect(host.notified.map((n) => n.title)).toEqual(['Late']);
    await tick(host);
    expect(host.notified).toHaveLength(1);
  });

  it('!wled publishes its request at the start', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u1');
    await create(router, 'u1', { calendarId: cal, title: 'Movie !wled cinema', ...at('20:00') });
    host.setNow(new Date('2027-01-04T19:00:05Z'));
    await tick(host);
    expect(named(host, 'wled.apply.request')).toEqual([{ target: 'all', preset: 'cinema' }]);
    expect(host.notified).toEqual([]);
  });

  it('upcoming published at each threshold once', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u1');
    await create(router, 'u1', { calendarId: cal, title: 'Meeting', ...at('11:00') }); // 10:00Z
    const seen: number[] = [];
    for (const t of ['08:30', '08:45', '09:00', '09:01', '09:30', '09:31', '09:45', '09:55', '09:56', '10:00']) {
      host.setNow(new Date(`2027-01-04T${t}:00Z`));
      const before = host.published.length;
      await tick(host);
      for (const p of host.published.slice(before)) {
        const pl = p.payload as { minutesUntil: number; userIds: string[] };
        if (p.name === 'calendar.event.upcoming' && pl.userIds[0] === 'u1') seen.push(pl.minutesUntil);
      }
    }
    // first sight (90 min) once, then 60, 30, 15, 5 and 0
    expect(seen).toEqual([90, 60, 30, 15, 5, 0]);
  });

  it('started published once per occurrence', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u1');
    await share(router, 'u1', cal, [{ userId: 'u2', level: 'view' }]);
    await create(router, 'u1', { calendarId: cal, title: 'Run #outdoor', ...at('10:00'), rrule: 'FREQ=DAILY;COUNT=2' });
    for (const t of ['2027-01-04T08:59:00Z', '2027-01-04T09:00:00Z', '2027-01-04T09:00:30Z', '2027-01-04T09:05:00Z', '2027-01-05T09:00:10Z']) {
      host.setNow(new Date(t));
      await tick(host);
    }
    const started = named(host, 'calendar.event.started');
    expect(started.map((s) => s['start'])).toEqual(['2027-01-04T09:00:00.000Z', '2027-01-05T09:00:00.000Z']);
    expect(started[0]).toMatchObject({ title: 'Run #outdoor', tags: ['outdoor'], userIds: ['u1', 'u2'] });
  });

  it('day.summary lists only that user\'s visible events', async () => {
    const { router, host } = await setup();
    const c1 = await personal(router, 'u1');
    const c2 = await personal(router, 'u2');
    await share(router, 'u1', c1, [{ userId: 'u2', level: 'view' }]);
    await create(router, 'u1', { calendarId: c1, title: 'Shared', ...at('12:00') });
    await create(router, 'u1', { calendarId: c1, title: 'Secret #private', ...at('13:00') });
    await create(router, 'u2', { calendarId: c2, title: 'Eli only', ...at('14:00') });
    await create(router, 'u1', { calendarId: c1, title: 'Tomorrow', ...at('12:00', '2027-01-05') });
    await tick(host);
    const latest = (userId: string) => named(host, 'calendar.day.summary').filter((s) => s['userId'] === userId).at(-1) as { date: string; events: Array<{ title: string }> };
    expect(latest('u1').date).toBe('2027-01-04');
    expect(latest('u1').events.map((e) => e.title)).toEqual(['Shared', 'Secret #private']);
    expect(latest('u2').events.map((e) => e.title)).toEqual(['Shared', 'Eli only']);
    expect(named(host, 'calendar.day.summary').some((s) => s['userId'] === 'u3')).toBe(false); // nothing to say
  });

  it('snapshot excludes other users\' private events', async () => {
    const inst: ModuleInstance = { id: 'i-eli', ownerId: 'u2', pageId: 'p1', settings: {} };
    const { router, host } = await setup();
    host.setInstances([inst]);
    const c1 = await personal(router, 'u1');
    await share(router, 'u1', c1, [{ userId: 'u2', level: 'edit' }]);
    await create(router, 'u1', { calendarId: c1, title: 'Dinner', ...at('19:00') });
    await create(router, 'u1', { calendarId: c1, title: 'Gift shopping #private', ...at('15:00') });
    await create(router, 'u1', { calendarId: c1, title: 'Next week', ...at('10:00', '2027-01-06') });
    await tick(host);
    const snap = host.pushed.filter((p) => p.instanceId === 'i-eli').at(-1)!.data as Snapshot;
    expect(snap.date).toBe('2027-01-04');
    expect(snap.today.map((o) => o.displayTitle)).toEqual(['Dinner']);
    expect(snap.next.map((o) => o.displayTitle)).toEqual(['Next week']);
    expect(snap.calendars.map((c) => c.id)).toEqual([c1]);
    expect(JSON.stringify(host.pushed)).not.toContain('Gift');
  });
});
