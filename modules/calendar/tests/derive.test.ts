import { describe, expect, it } from 'vitest';
import server from '../server/index.js';
import { as, base, create, personal, setup } from './api-helpers.js';
import type { MockHost } from '@dash/module-kit/testing';

const requests = (host: MockHost, name = 'todo.create.request') =>
  host.published.filter((p) => p.name === name).map((p) => p.payload as Record<string, unknown>);

const runDerive = (host: MockHost) => server.jobs!['derive']!({ host, instance: null, signal: new AbortController().signal });

describe('derive', () => {
  it('@dani creates one todo request due at start', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u2');
    await create(router, 'u2', { calendarId: cal, title: 'Dentist @dani' });
    await runDerive(host);
    expect(requests(host)).toEqual([
      expect.objectContaining({ list: 'deadline', title: 'Dentist @dani', due: '2027-01-05T08:00:00.000Z', assigneeId: 'u1' }),
    ]);
  });

  it('#shopping a, b creates two', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u1');
    await create(router, 'u1', { calendarId: cal, title: 'BBQ #shopping sausages, buns' });
    expect(requests(host).map((r) => [r['list'], r['title'], r['due']])).toEqual([
      ['shopping', 'sausages', null],
      ['shopping', 'buns', null],
    ]);
  });

  it('editing title to remove @dani publishes todo.remove.request', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u2');
    const ev = await create(router, 'u2', { calendarId: cal, title: 'Dentist @dani' });
    const key = requests(host)[0]!['sourceKey'];
    await router.call('PUT', `/events/${ev.uid}`, { ...as('u2'), body: { ...base, calendarId: cal, etag: ev.etag, title: 'Dentist' } });
    expect(requests(host, 'todo.remove.request')).toEqual([{ sourceKey: key }]);
  });

  it('deleting event removes all its derived items and reminders', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u1');
    const ev = await create(router, 'u1', { calendarId: cal, title: 'Trip @eli #shopping maps !remind 1d' });
    expect(requests(host)).toHaveLength(2);
    expect(host.store.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM m_calendar_reminders')?.n).toBe(1);
    await router.call('DELETE', `/events/${ev.uid}`, { ...as('u1'), query: { calendarId: cal, etag: ev.etag } });
    expect(requests(host, 'todo.remove.request').map((r) => r['sourceKey']).sort()).toEqual(requests(host).map((r) => r['sourceKey']).sort());
    expect(host.store.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM m_calendar_reminders')?.n).toBe(0);
    expect(host.store.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM m_calendar_derived')?.n).toBe(0);
  });

  it('weekly event derives only occurrences within horizon', async () => {
    const { router, host } = await setup();
    host.setConfig({ deriveHorizonDays: 14, defaultReminderMin: 0 });
    const cal = await personal(router, 'u1');
    await create(router, 'u1', { calendarId: cal, title: 'Bins #chore', rrule: 'FREQ=WEEKLY' });
    // now = Mon 2027-01-04 08:00Z: Tue 5th, 12th and (within 14 days) 18th? → 5th, 12th only (19th is past the horizon)
    expect(requests(host).map((r) => r['due'])).toEqual(['2027-01-05T08:00:00.000Z', '2027-01-12T08:00:00.000Z']);
    expect(requests(host).every((r) => r['list'] === 'chores' && r['assigneeId'] === 'u1')).toBe(true);
    host.setNow(new Date('2027-01-08T08:00:00Z'));
    await runDerive(host);
    expect(requests(host).map((r) => r['due'])).toEqual(['2027-01-05T08:00:00.000Z', '2027-01-12T08:00:00.000Z', '2027-01-19T08:00:00.000Z']);
    expect(requests(host, 'todo.remove.request')).toEqual([]); // the 5th aged out silently
  });

  it('moving an event updates due date under the same sourceKey', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u1');
    const ev = await create(router, 'u1', { calendarId: cal, title: 'Call @eli' });
    await router.call('PUT', `/events/${ev.uid}`, {
      ...as('u1'),
      body: { ...base, start: '2027-01-06T15:00:00', end: '2027-01-06T16:00:00', calendarId: cal, etag: ev.etag, title: 'Call @eli' },
    });
    const all = requests(host);
    expect(all).toHaveLength(2);
    expect(all[0]!['sourceKey']).toBe(all[1]!['sourceKey']);
    expect(all[1]!['due']).toBe('2027-01-06T14:00:00.000Z');
    expect(requests(host, 'todo.remove.request')).toEqual([]);
  });

  it('!prep 2d is due two days before', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u1');
    await create(router, 'u1', { calendarId: cal, title: 'Exam !prep 2d', start: '2027-01-10T09:00:00', end: '2027-01-10T11:00:00' });
    expect(requests(host)).toEqual([
      expect.objectContaining({ list: 'deadline', title: 'Prepare: Exam', due: '2027-01-08T08:00:00.000Z', assigneeId: 'u1' }),
    ]);
  });

  it('!pin, !countdown and !wled publish their requests', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u1');
    await create(router, 'u1', { calendarId: cal, title: 'Party !pin !countdown !wled garden:party @eli' });
    expect(requests(host, 'pin.request')).toEqual([expect.objectContaining({ title: 'Party @eli', date: '2027-01-05', userIds: ['u1', 'u2'] })]);
    expect(requests(host, 'countdown.request')).toEqual([expect.objectContaining({ title: 'Party @eli', at: '2027-01-05T08:00:00.000Z' })]);
    const wled = host.store.db.get<{ fire_at: string; action_json: string }>('SELECT fire_at, action_json FROM m_calendar_reminders');
    expect(wled?.fire_at).toBe('2027-01-05T08:00:00.000Z');
    expect(JSON.parse(wled!.action_json)).toEqual({ name: 'wled.apply.request', payload: { target: 'garden', preset: 'party' } });
  });

  it('unknown commands are ordinary text', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u1');
    await create(router, 'u1', { calendarId: cal, title: 'Meeting !foo bar #baz' });
    expect(host.published.filter((p) => p.name !== 'calendar.event.changed' && p.name !== 'calendar.day.summary')).toEqual([]);
  });
});
