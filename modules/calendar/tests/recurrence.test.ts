import { describe, expect, it } from 'vitest';
import { expand } from '../server/recurrence.js';
import { toVEvent, type EventInput } from '../server/ical.js';
import { fixture, stored } from './helpers.js';

const NOW = new Date('2027-01-05T10:00:00.000Z');
const d = (s: string): Date => new Date(s);

function occurrences(ics: string, uid: string, from: string, to: string, max?: number) {
  return expand([stored(ics, uid)], d(from), d(to), max);
}

describe('expand', () => {
  it('weekly event with EXDATE skips that date', () => {
    const occ = occurrences(fixture('weekly-exdate'), 'weekly-1@fixture', '2027-03-01T00:00:00Z', '2027-06-01T00:00:00Z');
    const days = occ.map((o) => o.start.slice(0, 10));
    // COUNT=8 Mondays from 2027-03-01, minus the excluded 2027-03-15 (it still uses up one of the 8).
    expect(days).toEqual(['2027-03-01', '2027-03-08', '2027-03-22', '2027-03-29', '2027-04-05', '2027-04-12', '2027-04-19']);
    expect(occ.every((o) => o.uid === 'weekly-1@fixture' && !o.isOverride)).toBe(true);
    expect(occ[0]).toMatchObject({
      title: 'Team stand-up',
      start: '2027-03-01T09:00:00',
      end: '2027-03-01T10:00:00',
      startUtc: '2027-03-01T08:00:00.000Z',
      endUtc: '2027-03-01T09:00:00.000Z',
      recurrenceId: '2027-03-01T08:00:00Z',
    });
  });

  it('overridden instance replaces the generated one', () => {
    const occ = occurrences(fixture('overridden'), 'override-1@fixture', '2027-06-01T00:00:00Z', '2027-06-30T00:00:00Z');
    expect(occ.map((o) => [o.title, o.startUtc])).toEqual([
      ['Standup', '2027-06-01T10:00:00.000Z'],
      ['Standup', '2027-06-02T10:00:00.000Z'],
      ['Standup (moved)', '2027-06-03T14:00:00.000Z'],
      ['Standup', '2027-06-04T10:00:00.000Z'],
      ['Standup', '2027-06-05T10:00:00.000Z'],
    ]);
    const moved = occ.find((o) => o.isOverride);
    expect(moved?.recurrenceId).toBe('2027-06-03T10:00:00Z');
    // An override moved out of the window drops out; the generated instance does not come back.
    const narrow = occurrences(fixture('overridden'), 'override-1@fixture', '2027-06-03T00:00:00Z', '2027-06-03T12:00:00Z');
    expect(narrow).toEqual([]);
  });

  it('expand caps at max and at 400 days', () => {
    const daily: EventInput = {
      title: 'Daily',
      start: '2027-01-01T08:00:00',
      end: '2027-01-01T09:00:00',
      allDay: false,
      timeZone: 'UTC',
      rrule: 'FREQ=DAILY',
    };
    const ics = toVEvent(daily, 'daily@x', NOW);
    const all = occurrences(ics, 'daily@x', '2027-01-01T00:00:00Z', '2031-01-01T00:00:00Z');
    expect(all).toHaveLength(400);
    expect(all[399]?.start).toBe('2028-02-04T08:00:00');
    expect(occurrences(ics, 'daily@x', '2027-01-01T00:00:00Z', '2031-01-01T00:00:00Z', 5)).toHaveLength(5);
    expect(occurrences(ics, 'daily@x', '2027-01-01T00:00:00Z', '2027-01-11T00:00:00Z')).toHaveLength(10);
    const many = toVEvent({ ...daily, rrule: 'FREQ=HOURLY' }, 'hourly@x', NOW);
    expect(occurrences(many, 'hourly@x', '2027-01-01T00:00:00Z', '2027-12-01T00:00:00Z')).toHaveLength(2000);
  });

  it('honours COUNT and UNTIL', () => {
    const base: EventInput = {
      title: 'x',
      start: '2027-05-03T08:00:00',
      end: '2027-05-03T09:00:00',
      allDay: false,
      timeZone: 'UTC',
    };
    const count = toVEvent({ ...base, rrule: 'FREQ=DAILY;COUNT=3' }, 'c@x', NOW);
    expect(occurrences(count, 'c@x', '2027-05-01T00:00:00Z', '2027-06-01T00:00:00Z')).toHaveLength(3);
    const until = toVEvent({ ...base, rrule: 'FREQ=DAILY;UNTIL=20270505T080000Z' }, 'u@x', NOW);
    expect(occurrences(until, 'u@x', '2027-05-01T00:00:00Z', '2027-06-01T00:00:00Z').map((o) => o.start.slice(0, 10))).toEqual([
      '2027-05-03',
      '2027-05-04',
      '2027-05-05',
    ]);
  });

  it('returns a single event once, a floating event as UTC, and respects the window', () => {
    const one = occurrences(fixture('simple'), 'simple-1@fixture', '2027-02-10T08:00:00Z', '2027-02-10T08:30:00Z');
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({ recurrenceId: '', startUtc: '2027-02-10T08:00:00.000Z', endUtc: '2027-02-10T09:30:00.000Z' });
    // Ends exactly at the window start: not in it.
    expect(occurrences(fixture('simple'), 'simple-1@fixture', '2027-02-10T09:30:00Z', '2027-02-11T00:00:00Z')).toEqual([]);
    const floating = occurrences(fixture('floating'), 'floating-1@fixture', '2027-06-01T00:00:00Z', '2027-06-02T00:00:00Z');
    expect(floating[0]).toMatchObject({ timeZone: 'floating', start: '2027-06-01T18:00:00', startUtc: '2027-06-01T18:00:00.000Z' });
  });

  it('a TZID without VTIMEZONE expands like the same zone with one', () => {
    const range = ['2027-03-01T00:00:00Z', '2027-12-31T00:00:00Z'] as const;
    const withTz = occurrences(fixture('weekly-exdate').replace('COUNT=8', 'COUNT=40'), 'weekly-1@fixture', ...range);
    const asIntl = fixture('no-vtimezone');
    const without = occurrences(asIntl.replace('BYDAY=MO', 'BYDAY=MO;COUNT=40'), 'novtz-1@fixture', ...range);
    const strip = (xs: typeof withTz) => xs.map((o) => o.startUtc).filter((u) => u !== '2027-03-15T08:00:00.000Z');
    expect(strip(without)).toEqual(strip(withTz));
    expect(without.length).toBeGreaterThan(30);
  });

  it.each(['Europe/Berlin', 'America/New_York', 'Australia/Sydney', 'Asia/Kolkata', 'Asia/Tokyo', 'America/Sao_Paulo', 'Pacific/Auckland'])(
    'keeps 09:00 wall time all year in %s, from written rules and from IANA-derived tables',
    (timeZone) => {
      const ics = toVEvent(
        { title: 'x', start: '2027-01-04T09:00:00', end: '2027-01-04T10:00:00', allDay: false, timeZone, rrule: 'FREQ=WEEKLY' },
        'z@x',
        NOW,
      );
      // The same file with its VTIMEZONE removed: the zone comes from the runtime's IANA data.
      const bare = ics.replace(/BEGIN:VTIMEZONE[\s\S]*?END:VTIMEZONE\r\n/, '');
      expect(bare).not.toContain('VTIMEZONE');
      for (const text of [ics, bare]) {
        const occ = occurrences(text, 'z@x', '2027-01-04T00:00:00Z', '2028-01-01T00:00:00Z');
        expect(occ.length).toBeGreaterThan(48);
        for (const o of occ) {
          const local = new Intl.DateTimeFormat('sv-SE', { timeZone, timeStyle: 'short' }).format(new Date(o.startUtc));
          expect(local, `${o.start} ${o.startUtc}`).toBe('09:00');
        }
      }
    },
  );

  it('reads a local time that occurs twice as its first occurrence', () => {
    const ics = toVEvent(
      { title: 'x', start: '2027-10-30T02:30:00', end: '2027-10-30T03:00:00', allDay: false, timeZone: 'Europe/Berlin', rrule: 'FREQ=DAILY;COUNT=3' },
      'f@x',
      NOW,
    );
    expect(occurrences(ics, 'f@x', '2027-10-29T00:00:00Z', '2027-11-02T00:00:00Z').map((o) => o.startUtc)).toEqual([
      '2027-10-30T00:30:00.000Z',
      '2027-10-31T00:30:00.000Z', // 02:30 CEST, the first of the two 02:30
      '2027-11-01T01:30:00.000Z',
    ]);
  });
});
