import { describe, expect, it } from 'vitest';
import { as, base, create, events, personal, setup, share } from './api-helpers.js';

const weekly = { title: 'Stand-up', rrule: 'FREQ=WEEKLY;COUNT=4' };

describe('event API', () => {
  it('creates, lists with the DTO shape, and publishes calendar.event.changed', async () => {
    const { router, host } = await setup();
    const cal = await personal(router, 'u1');
    const ev = await create(router, 'u1', { calendarId: cal, title: 'Dentist @eli #outdoor', location: 'Town' });
    const [dto] = await events(router, 'u1');
    expect(dto).toMatchObject({
      uid: ev.uid,
      calendarId: cal,
      etag: ev.etag,
      recurrenceId: null,
      title: 'Dentist @eli #outdoor',
      start: '2027-01-05T09:00:00',
      startUtc: '2027-01-05T08:00:00.000Z',
      timeZone: 'Europe/Berlin',
      tags: ['outdoor'],
      mentions: ['eli'],
      color: '#3b82f6',
      editable: true,
      rrule: null,
    });
    expect(host.published).toContainEqual({ name: 'calendar.event.changed', payload: { uid: ev.uid, calendarId: cal, kind: 'created' } });
  });

  it('stranger gets no events from unshared calendar', async () => {
    const { router } = await setup();
    const cal = await personal(router, 'u1');
    await create(router, 'u1', { calendarId: cal });
    expect(await events(router, 'u2')).toEqual([]);
    const res = await router.call('GET', '/events', { ...as('u2', 'view'), query: { from: '2027-01-01T00:00:00Z', to: '2027-02-01T00:00:00Z', calendarIds: cal } });
    expect((res.body as { events: unknown[] }).events).toEqual([]);
  });

  it('private event invisible to other user on shared calendar', async () => {
    const { router } = await setup();
    const cal = await personal(router, 'u1');
    await share(router, 'u1', cal, [{ userId: 'u2', level: 'edit' }]);
    const priv = await create(router, 'u1', { calendarId: cal, title: 'Doctor #private' });
    await create(router, 'u1', { calendarId: cal, title: 'Dinner' });
    expect((await events(router, 'u1')).map((e) => e.title).sort()).toEqual(['Dinner', 'Doctor #private']);
    expect((await events(router, 'u2')).map((e) => e.title)).toEqual(['Dinner']);
    // and it cannot be changed blind either
    const put = await router.call('PUT', `/events/${priv.uid}`, { ...as('u2'), body: { ...base, calendarId: cal, etag: priv.etag, title: 'x' } });
    expect(put.status).toBe(404);
  });

  it('scope this creates override, series otherwise unchanged', async () => {
    const { router } = await setup();
    const cal = await personal(router, 'u1');
    const ev = await create(router, 'u1', { calendarId: cal, ...weekly });
    const before = await events(router, 'u1');
    expect(before.map((e) => e.start)).toEqual(['2027-01-05T09:00:00', '2027-01-12T09:00:00', '2027-01-19T09:00:00', '2027-01-26T09:00:00']);
    const second = before[1]!;
    expect(second.recurrenceId).toBe('2027-01-12T08:00:00Z');
    const res = await router.call('PUT', `/events/${ev.uid}`, {
      ...as('u1'),
      body: { ...base, start: '2027-01-12T11:00:00', end: '2027-01-12T12:00:00', title: 'Moved stand-up', calendarId: cal, etag: ev.etag, scope: 'this', occurrenceStart: second.recurrenceId },
    });
    expect(res.status).toBe(200);
    const after = await events(router, 'u1');
    expect(after.map((e) => [e.start, e.title])).toEqual([
      ['2027-01-05T09:00:00', 'Stand-up'],
      ['2027-01-12T11:00:00', 'Moved stand-up'],
      ['2027-01-19T09:00:00', 'Stand-up'],
      ['2027-01-26T09:00:00', 'Stand-up'],
    ]);
    expect(after[1]!.recurrenceId).toBe('2027-01-12T08:00:00Z');
  });

  it('delete scope this leaves out one instance', async () => {
    const { router } = await setup();
    const cal = await personal(router, 'u1');
    const ev = await create(router, 'u1', { calendarId: cal, ...weekly });
    const res = await router.call('DELETE', `/events/${ev.uid}`, { ...as('u1'), query: { calendarId: cal, etag: ev.etag, scope: 'this', occurrenceStart: '2027-01-19T08:00:00Z' } });
    expect(res.status).toBe(204);
    expect((await events(router, 'u1')).map((e) => e.start.slice(0, 10))).toEqual(['2027-01-05', '2027-01-12', '2027-01-26']);
  });

  it('scope future splits series', async () => {
    const { router } = await setup();
    const cal = await personal(router, 'u1');
    const ev = await create(router, 'u1', { calendarId: cal, title: 'Stand-up', rrule: 'FREQ=WEEKLY' });
    const res = await router.call('PUT', `/events/${ev.uid}`, {
      ...as('u1'),
      body: { ...base, start: '2027-01-19T10:00:00', end: '2027-01-19T11:00:00', rrule: 'FREQ=WEEKLY', title: 'Later stand-up', calendarId: cal, etag: ev.etag, scope: 'future', occurrenceStart: '2027-01-19T08:00:00Z' },
    });
    expect(res.status).toBe(200);
    const { splitUid } = res.body as { splitUid: string };
    expect(splitUid).toBeTruthy();
    const after = await events(router, 'u1');
    expect(after.map((e) => [e.uid === ev.uid ? 'old' : e.uid === splitUid ? 'new' : '?', e.start])).toEqual([
      ['old', '2027-01-05T09:00:00'],
      ['old', '2027-01-12T09:00:00'],
      ['new', '2027-01-19T10:00:00'],
      ['new', '2027-01-26T10:00:00'],
    ]);
    expect(after[0]!.rrule).toContain('UNTIL=');
  });

  it('view-share user cannot write (403)', async () => {
    const { router } = await setup();
    const cal = await personal(router, 'u1');
    await share(router, 'u1', cal, [{ userId: 'u2', level: 'view' }]);
    const ev = await create(router, 'u1', { calendarId: cal });
    const [seen] = await events(router, 'u2');
    expect(seen?.editable).toBe(false);
    const post = await router.call('POST', '/events', { ...as('u2'), body: { ...base, title: 'x', calendarId: cal } });
    expect(post.status).toBe(403);
    const put = await router.call('PUT', `/events/${ev.uid}`, { ...as('u2'), body: { ...base, title: 'x', calendarId: cal, etag: ev.etag } });
    expect(put.status).toBe(403);
    const del = await router.call('DELETE', `/events/${ev.uid}`, { ...as('u2'), query: { calendarId: cal, etag: ev.etag } });
    expect(del.status).toBe(403);
  });

  it('module level view makes events read-only even on an edit share', async () => {
    const { router } = await setup();
    const cal = await personal(router, 'u1');
    await share(router, 'u1', cal, [{ userId: 'u2', level: 'edit' }]);
    await create(router, 'u1', { calendarId: cal });
    const [seen] = await events(router, 'u2', undefined, undefined, 'view');
    expect(seen?.editable).toBe(false);
  });

  it('displayTitle strips !remind 30m', async () => {
    const { router } = await setup();
    const cal = await personal(router, 'u1');
    await create(router, 'u1', { calendarId: cal, title: 'Dentist !remind 30m @eli' });
    const [dto] = await events(router, 'u1');
    expect(dto?.displayTitle).toBe('Dentist @eli');
    expect(dto?.title).toBe('Dentist !remind 30m @eli');
  });

  it('rejects a malformed time zone with 422 and stores nothing', async () => {
    const { router } = await setup();
    const cal = await personal(router, 'u1');
    const res = await router.call('POST', '/events', { ...as('u1'), body: { ...base, title: 'x', timeZone: 'Mars/Base', calendarId: cal } });
    expect(res.status).toBe(422);
    expect(await events(router, 'u1')).toEqual([]);
  });
});

describe('POST /events/:uid/delete', () => {
  it('deletes like DELETE, with the fields in the body', async () => {
    const { router } = await setup();
    const cal = await personal(router, 'u1');
    const ev = await create(router, 'u1', { calendarId: cal, title: 'Stand-up', rrule: 'FREQ=WEEKLY;COUNT=3' });
    const stale = await router.call('POST', `/events/${ev.uid}/delete`, { ...as('u1'), body: { calendarId: cal, etag: '"0000000000000000"' } });
    expect(stale.status).toBe(409);
    const one = await router.call('POST', `/events/${ev.uid}/delete`, { ...as('u1'), body: { calendarId: cal, etag: ev.etag, scope: 'future', occurrenceStart: '2027-01-12T08:00:00Z' } });
    expect(one.status).toBe(204);
    expect((await events(router, 'u1')).map((e) => e.start.slice(0, 10))).toEqual(['2027-01-05']);
  });
});
