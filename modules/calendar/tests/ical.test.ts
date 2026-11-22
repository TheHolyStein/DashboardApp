import { describe, expect, it } from 'vitest';
import { DashError } from '@dash/contract';
import { createMockHostWithSetup } from '@dash/module-kit/testing';
import server from '../server/index.js';
import { fromVCalendar, toVEvent, type EventInput } from '../server/ical.js';
import { upsertEvent } from '../server/events-repo.js';
import { createCalendar } from '../server/calendars.js';
import { fixture } from './helpers.js';

const NOW = new Date('2027-01-05T10:00:00.000Z');
const FIXTURES = ['simple', 'all-day', 'weekly-exdate', 'overridden', 'floating', 'foreign-tz', 'no-vtimezone'];

function inputOf(p: ReturnType<typeof fromVCalendar>[number]): EventInput {
  return {
    title: p.title,
    description: p.description,
    location: p.location,
    start: p.start,
    end: p.end,
    allDay: p.allDay,
    timeZone: p.timeZone,
    rrule: p.rrule,
    exdates: p.exdates,
  };
}

describe('ical', () => {
  it('round-trips each fixture: fromVCalendar(toVEvent(x)) equals x', () => {
    for (const name of FIXTURES) {
      const master = fromVCalendar(fixture(name)).find((e) => e.recurrenceId === '');
      expect(master, name).toBeDefined();
      const x = inputOf(master!);
      const ics = toVEvent(x, master!.uid, NOW);
      expect(ics, name).toContain('BEGIN:VCALENDAR');
      const again = fromVCalendar(ics);
      expect(again, name).toHaveLength(1);
      expect(inputOf(again[0]!), name).toEqual(x);
      expect(again[0]!.uid, name).toBe(master!.uid);
    }
  });

  it('writes a VTIMEZONE for a named zone and none for UTC, floating or all-day', () => {
    const base = { title: 'x', start: '2027-06-01T09:00:00', end: '2027-06-01T10:00:00', allDay: false };
    const berlin = toVEvent({ ...base, timeZone: 'Europe/Berlin' }, 'u1', NOW);
    expect(berlin).toContain('BEGIN:VTIMEZONE');
    expect(berlin).toContain('TZID:Europe/Berlin');
    expect(berlin).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU');
    expect(berlin).toContain('DTSTART;TZID=Europe/Berlin:20270601T090000');
    expect(toVEvent({ ...base, timeZone: 'UTC' }, 'u1', NOW)).not.toContain('VTIMEZONE');
    expect(toVEvent({ ...base, timeZone: 'floating' }, 'u1', NOW)).not.toContain('VTIMEZONE');
    expect(
      toVEvent({ ...base, start: '2027-06-01', end: '2027-06-02', allDay: true, timeZone: 'floating' }, 'u1', NOW),
    ).toContain('DTSTART;VALUE=DATE:20270601');
  });

  it('reads the fixtures as expected', () => {
    const simple = fromVCalendar(fixture('simple'))[0]!;
    expect(simple).toMatchObject({
      uid: 'simple-1@fixture',
      title: 'Dentist, Dr. Meier',
      description: 'Bring the insurance card.\nSecond line',
      location: 'Main Street 5',
      start: '2027-02-10T09:00:00',
      end: '2027-02-10T10:30:00',
      timeZone: 'Europe/Berlin',
      allDay: false,
    });
    const overridden = fromVCalendar(fixture('overridden'));
    expect(overridden.map((e) => e.recurrenceId)).toEqual(['', '2027-06-03T10:00:00Z']);
    expect(fromVCalendar(fixture('floating'))[0]).toMatchObject({ timeZone: 'floating', start: '2027-06-01T18:00:00' });
    expect(fromVCalendar(fixture('weekly-exdate'))[0]).toMatchObject({
      rrule: 'FREQ=WEEKLY;COUNT=8;BYDAY=MO',
      exdates: ['2027-03-15T09:00:00'],
    });
  });

  it.each([
    ['not an ics at all', 'hello world'],
    ['no VEVENT', 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n'],
    ['no UID', 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART:20270101T100000Z\nEND:VEVENT\nEND:VCALENDAR\n'],
    ['no DTSTART', 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nEND:VEVENT\nEND:VCALENDAR\n'],
    [
      'unknown zone without VTIMEZONE',
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nDTSTART;TZID=Mars/Olympus:20270101T100000\nEND:VEVENT\nEND:VCALENDAR\n',
    ],
    [
      'ends before start',
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nDTSTART:20270101T100000Z\nDTEND:20270101T090000Z\nEND:VEVENT\nEND:VCALENDAR\n',
    ],
    [
      'two UIDs',
      'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nDTSTART:20270101T100000Z\nEND:VEVENT\nBEGIN:VEVENT\nUID:b\nDTSTART:20270101T100000Z\nEND:VEVENT\nEND:VCALENDAR\n',
    ],
  ])('rejects %s with invalid', (_name, ics) => {
    expect(() => fromVCalendar(ics)).toThrow(DashError);
    try {
      fromVCalendar(ics);
    } catch (e) {
      expect((e as DashError).code).toBe('invalid');
    }
  });

  it('malformed ICS → DashError(\'invalid\'), nothing stored', async () => {
    const host = await createMockHostWithSetup(server, { now: NOW });
    const db = host.store.db;
    const cal = createCalendar(db, 'u1', { name: 'C', color: '#000000' }, { now: NOW });
    let error: unknown;
    try {
      upsertEvent(db, cal.id, 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nEND:VEVENT\nEND:VCALENDAR\n', {
        creatorId: 'u1',
        now: NOW,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DashError);
    expect((error as DashError).code).toBe('invalid');
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM m_calendar_events')?.n).toBe(0);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM m_calendar_changes')?.n).toBe(0);
    expect(db.get<{ s: number }>('SELECT sync_seq AS s FROM m_calendar_calendars WHERE id = ?', [cal.id])?.s).toBe(0);
  });
});
