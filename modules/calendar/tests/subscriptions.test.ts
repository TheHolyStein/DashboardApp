import { describe, expect, it } from 'vitest';
import type { MockResponse } from '@dash/module-kit/testing';
import server from '../server/index.js';
import { as, events, setup } from './api-helpers.js';
import { fixture } from './helpers.js';

const URL = 'https://holidays.example/de.ics';

async function withSubscription(feed: MockResponse) {
  const ctx = await setup();
  ctx.host.respond(URL, feed);
  const res = await ctx.router.call('POST', '/subscriptions', { ...as('u1'), body: { name: 'Holidays', url: URL, color: '#22aa44' } });
  expect(res.status).toBe(200);
  const cal = res.body as { id: string; kind: string; access: string };
  const runJob = () => server.jobs!['subscriptions']!({ host: ctx.host, instance: null, signal: new AbortController().signal });
  return { ...ctx, cal, runJob };
}

const titles = async (router: Parameters<typeof events>[0]) => (await events(router, 'u1', '2026-12-01T00:00:00Z')).map((e) => e.title).sort();

function veventFeed(n: number): string {
  const body = Array.from({ length: n }, (_, i) =>
    ['BEGIN:VEVENT', `UID:e${i}@bulk`, 'DTSTAMP:20260101T000000Z', 'DTSTART;VALUE=DATE:20270110', 'SUMMARY:x', 'END:VEVENT'].join('\r\n'),
  ).join('\r\n');
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//t//EN\r\n${body}\r\nEND:VCALENDAR\r\n`;
}

describe('subscriptions', () => {
  it('imports on creation with the fetch limits of the plan', async () => {
    const { router, host, cal } = await withSubscription({ data: fixture('holidays') });
    expect(cal.kind).toBe('subscription');
    expect(host.requests[0]).toEqual({ url: URL, opts: { rule: 'publicUrl', as: 'text', ttlSec: 3000, maxBytes: 5_000_000 } });
    expect(await titles(router)).toEqual(['Epiphany @dani !countdown #shopping cake', 'Fireworks !remind 10m', "New Year's Day"]);
  });

  it('import replaces previous events atomically', async () => {
    const feed: MockResponse = { data: fixture('holidays') };
    const { router, runJob, host } = await withSubscription(feed);
    feed.data = fixture('holidays').replace(/BEGIN:VEVENT\nUID:epiphany[\s\S]*?END:VEVENT\n/, '').replace("New Year's Day", 'Neujahr');
    host.published.length = 0;
    await runJob();
    expect(await titles(router)).toEqual(['Fireworks !remind 10m', 'Neujahr']);
    const kinds = host.published.filter((p) => p.name === 'calendar.event.changed').map((p) => (p.payload as { kind: string }).kind).sort();
    expect(kinds).toEqual(['deleted', 'updated']); // the unchanged Fireworks event is left alone
  });

  it('parse failure keeps old events and notifies owner once (dedupeKey)', async () => {
    const feed: MockResponse = { data: fixture('holidays') };
    const { router, runJob, host, cal } = await withSubscription(feed);
    feed.data = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:broken\r\nDTSTART:nonsense\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
    await runJob();
    await runJob();
    expect(await titles(router)).toHaveLength(3);
    expect(host.notified).toHaveLength(1);
    expect(host.notified[0]).toMatchObject({ level: 'warn', userIds: ['u1'], dedupeKey: `calendar:subscription:${cal.id}` });
    // works again → a later failure is reported again
    feed.data = fixture('holidays');
    await runJob();
    feed.data = 'not ics';
    await runJob();
    expect(host.notified).toHaveLength(2);
  });

  it('5001 events → rejected', async () => {
    const { router, host } = await withSubscription({ data: veventFeed(5001) });
    expect(await titles(router)).toEqual([]);
    expect(host.notified).toHaveLength(1);
    const ok = await withSubscription({ data: veventFeed(3) });
    expect(await titles(ok.router)).toHaveLength(3);
  });

  it('subscription events have editable:false', async () => {
    const { router, cal } = await withSubscription({ data: fixture('holidays') });
    const list = await events(router, 'u1');
    expect(list.every((e) => !e.editable)).toBe(true);
    const ev = list[0]!;
    const put = await router.call('PUT', `/events/${encodeURIComponent(ev.uid)}`, {
      ...as('u1'),
      body: { calendarId: cal.id, etag: ev.etag, title: 'x', start: '2027-01-01', end: '2027-01-02', allDay: true, timeZone: 'floating' },
    });
    expect(put.status).toBe(403);
    const post = await router.call('POST', '/events', {
      ...as('u1'),
      body: { calendarId: cal.id, title: 'x', start: '2027-01-01', end: '2027-01-02', allDay: true, timeZone: 'floating' },
    });
    expect(post.status).toBe(403);
  });

  it('commands in subscription events are not executed', async () => {
    const { host } = await withSubscription({ data: fixture('holidays') });
    host.setNow(new Date('2027-01-05T12:00:00Z'));
    await server.jobs!['derive']!({ host, instance: null, signal: new AbortController().signal });
    await server.jobs!['reminders']!({ host, instance: null, signal: new AbortController().signal });
    const derived = host.published.filter((p) => p.name !== 'calendar.event.changed' && p.name !== 'calendar.day.summary');
    expect(derived).toEqual([]);
    expect(host.notified).toEqual([]);
  });

  it('only the owner may delete a subscription; a local calendar is not one', async () => {
    const { router, cal } = await withSubscription({ data: fixture('holidays') });
    expect((await router.call('DELETE', `/subscriptions/${cal.id}`, as('u2'))).status).toBe(404);
    const personal = (await router.call('GET', '/calendars', as('u1', 'view'))).body as { calendars: Array<{ id: string; kind: string }> };
    const local = personal.calendars.find((c) => c.kind === 'local')!;
    expect((await router.call('DELETE', `/subscriptions/${local.id}`, as('u1'))).status).toBe(404);
    expect((await router.call('DELETE', `/subscriptions/${cal.id}`, as('u1'))).status).toBe(204);
    expect(await titles(router)).toEqual([]);
  });

  it('rejects non-http URLs, accepts webcal://', async () => {
    const { router, host } = await setup();
    const bad = await router.call('POST', '/subscriptions', { ...as('u1'), body: { name: 'x', url: 'file:///etc/passwd', color: '#000000' } });
    expect(bad.status).toBe(422);
    host.respond('https://cal.example/a.ics', { data: fixture('holidays') });
    const ok = await router.call('POST', '/subscriptions', { ...as('u1'), body: { name: 'x', url: 'webcal://cal.example/a.ics', color: '#000000' } });
    expect((ok.body as { sourceUrl: string }).sourceUrl).toBe('https://cal.example/a.ics');
  });
});
