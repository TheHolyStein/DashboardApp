import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DashError } from '@dash/contract';
import { createMockHostWithSetup } from '@dash/module-kit/testing';
import server from '../server/index.js';
import { createCalendar, deleteCalendar } from '../server/calendars.js';
import { deleteEvent, eventRows, etagOf, upsertEvent } from '../server/events-repo.js';
import { fixture } from './helpers.js';

const NOW = new Date('2027-01-05T10:00:00.000Z');

async function setup() {
  const host = await createMockHostWithSetup(server, { now: NOW });
  const db = host.store.db;
  const cal = createCalendar(db, 'u1', { name: 'C', color: '#000000' }, { now: NOW });
  return { db, cal };
}

type Db = Awaited<ReturnType<typeof setup>>['db'];
const seq = (db: Db, id: string) =>
  db.get<{ s: number }>('SELECT sync_seq AS s FROM m_calendar_calendars WHERE id = ?', [id])?.s;

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof DashError ? e.code : 'other';
  }
  return undefined;
}

describe('events repo', () => {
  it('stores the ICS byte for byte and derives the index columns', async () => {
    const { db, cal } = await setup();
    const ics = fixture('weekly-exdate').replace(/\n/g, '\r\n') + '\r\n';
    const res = upsertEvent(db, cal.id, ics, { creatorId: 'u1', now: NOW });
    expect(res).toEqual({
      uid: 'weekly-1@fixture',
      etag: `"${createHash('sha256').update(ics).digest('hex').slice(0, 16)}"`,
      created: true,
    });
    expect(res.etag).toBe(etagOf(ics));
    expect(res.etag).toMatch(/^"[0-9a-f]{16}"$/);
    const [row] = eventRows(db, cal.id, res.uid);
    expect(row?.ics).toBe(ics);
    expect(row).toMatchObject({
      recurrence_id: '',
      summary: 'Team stand-up',
      dtstart_utc: '2027-03-01T08:00:00.000Z',
      dtend_utc: '2027-03-01T09:00:00.000Z',
      all_day: 0,
      tzid: 'Europe/Berlin',
      has_rrule: 1,
      // COUNT=8 Mondays from 2027-03-01: the last (2027-04-19) ends at 08:00Z (CEST).
      until_utc: '2027-04-19T08:00:00.000Z',
      is_private: 0,
      creator_id: 'u1',
      etag: res.etag,
    });
  });

  it('stores overrides as rows of the same resource and endless series with no end', async () => {
    const { db, cal } = await setup();
    const res = upsertEvent(db, cal.id, fixture('overridden'), { creatorId: 'u1', now: NOW });
    expect(eventRows(db, cal.id, res.uid).map((r) => [r.recurrence_id, r.summary, r.has_rrule])).toEqual([
      ['', 'Standup', 1],
      ['2027-06-03T10:00:00Z', 'Standup (moved)', 0],
    ]);
    const endless = upsertEvent(db, cal.id, fixture('foreign-tz'), { creatorId: 'u1', now: NOW });
    expect(eventRows(db, cal.id, endless.uid)[0]?.until_utc).toBeNull();
    const allDay = upsertEvent(db, cal.id, fixture('all-day'), { creatorId: 'u1', now: NOW });
    expect(eventRows(db, cal.id, allDay.uid)[0]).toMatchObject({
      all_day: 1,
      tzid: 'floating',
      dtstart_utc: '2027-03-28T00:00:00.000Z',
      until_utc: '2027-03-29T00:00:00.000Z',
    });
  });

  it('every upsert and delete appends to the change log and bumps sync_seq in one transaction', async () => {
    const { db, cal } = await setup();
    expect(seq(db, cal.id)).toBe(0);
    const first = upsertEvent(db, cal.id, fixture('simple'), { creatorId: 'u1', now: NOW });
    expect(first.created).toBe(true);
    const later = new Date('2027-01-06T08:00:00.000Z');
    const again = upsertEvent(db, cal.id, fixture('simple').replace('Dentist', 'Doctor'), { creatorId: 'u2', now: later });
    expect(again.created).toBe(false);
    expect(again.etag).not.toBe(first.etag);
    deleteEvent(db, cal.id, first.uid, { now: later });
    expect(seq(db, cal.id)).toBe(3);
    expect(db.all('SELECT seq, uid, deleted, at FROM m_calendar_changes WHERE calendar_id = ? ORDER BY seq', [cal.id])).toEqual([
      { seq: 1, uid: 'simple-1@fixture', deleted: 0, at: NOW.toISOString() },
      { seq: 2, uid: 'simple-1@fixture', deleted: 0, at: later.toISOString() },
      { seq: 3, uid: 'simple-1@fixture', deleted: 1, at: later.toISOString() },
    ]);
    expect(eventRows(db, cal.id, first.uid)).toEqual([]);
    // The creator stays the first one.
    const rewritten = upsertEvent(db, cal.id, fixture('simple'), { creatorId: 'u2', now: later });
    expect(eventRows(db, cal.id, rewritten.uid)[0]?.creator_id).toBe('u2');
  });

  it('a failed write leaves rows, log and sync_seq untouched', async () => {
    const { db, cal } = await setup();
    upsertEvent(db, cal.id, fixture('simple'), { creatorId: 'u1', now: NOW });
    const before = seq(db, cal.id);
    expect(code(() => upsertEvent(db, cal.id, fixture('simple').replace('Dentist', 'Other'), { ifMatch: '"0000000000000000"', creatorId: 'u1', now: NOW }))).toBe('conflict');
    expect(code(() => upsertEvent(db, 'no-such-calendar', fixture('simple'), { creatorId: 'u1', now: NOW }))).toBe('not_found');
    expect(code(() => upsertEvent(db, cal.id, 'garbage', { creatorId: 'u1', now: NOW }))).toBe('invalid');
    expect(seq(db, cal.id)).toBe(before);
    expect(eventRows(db, cal.id, 'simple-1@fixture')[0]?.summary).toBe('Dentist, Dr. Meier');
  });

  it('If-Match: matching etag and * pass, a stale etag or a missing event conflicts', async () => {
    const { db, cal } = await setup();
    const first = upsertEvent(db, cal.id, fixture('simple'), { creatorId: 'u1', now: NOW });
    expect(code(() => upsertEvent(db, cal.id, fixture('floating'), { ifMatch: '*', creatorId: 'u1', now: NOW }))).toBe('conflict');
    const edited = fixture('simple').replace('Dentist', 'Doctor');
    const second = upsertEvent(db, cal.id, edited, { ifMatch: first.etag, creatorId: 'u1', now: NOW });
    expect(code(() => upsertEvent(db, cal.id, fixture('simple'), { ifMatch: first.etag, creatorId: 'u1', now: NOW }))).toBe('conflict');
    expect(upsertEvent(db, cal.id, fixture('simple'), { ifMatch: '*', creatorId: 'u1', now: NOW }).created).toBe(false);
    expect(code(() => deleteEvent(db, cal.id, 'simple-1@fixture', { ifMatch: second.etag, now: NOW }))).toBe('conflict');
    expect(code(() => deleteEvent(db, cal.id, 'nope', { now: NOW }))).toBe('not_found');
    deleteEvent(db, cal.id, 'simple-1@fixture', { ifMatch: etagOf(fixture('simple')), now: NOW });
  });

  it('deleting a calendar removes its events and change log', async () => {
    const { db, cal } = await setup();
    upsertEvent(db, cal.id, fixture('simple'), { creatorId: 'u1', now: NOW });
    deleteCalendar(db, cal.id, 'u1');
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM m_calendar_events')?.n).toBe(0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM m_calendar_changes')?.n).toBe(0);
  });
});
