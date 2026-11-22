import { describe, expect, it } from 'vitest';
import { expand } from '../server/recurrence.js';
import { toVEvent, type EventInput } from '../server/ical.js';
import { fixture, stored } from './helpers.js';

const NOW = new Date('2027-01-05T10:00:00.000Z');

function run(input: EventInput, from: string, to: string) {
  const ics = toVEvent(input, 'dst@x', NOW);
  return expand([stored(ics, 'dst@x')], new Date(from), new Date(to));
}

function wall(utcIso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(utcIso));
}

const weeklyBerlin: EventInput = {
  title: 'Weekly',
  start: '2027-03-01T09:00:00',
  end: '2027-03-01T10:00:00',
  allDay: false,
  timeZone: 'Europe/Berlin',
  rrule: 'FREQ=WEEKLY;BYDAY=MO',
};

describe('recurrence across DST', () => {
  it('weekly 09:00 Europe/Berlin event is at 08:00Z before 2027-03-28 and 07:00Z after', () => {
    const occ = run(weeklyBerlin, '2027-03-01T00:00:00Z', '2027-04-12T00:00:00Z');
    expect(occ.map((o) => o.startUtc)).toEqual([
      '2027-03-01T08:00:00.000Z',
      '2027-03-08T08:00:00.000Z',
      '2027-03-15T08:00:00.000Z',
      '2027-03-22T08:00:00.000Z',
      '2027-03-29T07:00:00.000Z',
      '2027-04-05T07:00:00.000Z',
    ]);
    // The wall clock never moves.
    expect(new Set(occ.map((o) => o.start.slice(11)))).toEqual(new Set(['09:00:00']));
  });

  it('same for the October change back', () => {
    const occ = run(
      { ...weeklyBerlin, start: '2027-10-04T09:00:00', end: '2027-10-04T10:00:00' },
      '2027-10-01T00:00:00Z',
      '2027-11-10T00:00:00Z',
    );
    expect(occ.map((o) => o.startUtc)).toEqual([
      '2027-10-04T07:00:00.000Z',
      '2027-10-11T07:00:00.000Z',
      '2027-10-18T07:00:00.000Z',
      '2027-10-25T07:00:00.000Z',
      '2027-11-01T08:00:00.000Z',
      '2027-11-08T08:00:00.000Z',
    ]);
  });

  it('all-day event on 2027-03-28 has the same date for a user in America/New_York and Asia/Tokyo', () => {
    const [occ] = expand([stored(fixture('all-day'), 'allday-1@fixture')], new Date('2027-03-27T00:00:00Z'), new Date('2027-03-30T00:00:00Z'));
    expect(occ).toBeDefined();
    expect(occ).toMatchObject({ allDay: true, start: '2027-03-28', end: '2027-03-29', timeZone: 'floating' });
    // The date is the data; a viewer's zone never shifts it (its UTC anchor is midnight of that date).
    expect(occ!.startUtc.slice(0, 10)).toBe('2027-03-28');
    // Also not found on the neighbouring days, whatever the viewer's offset is.
    expect(expand([stored(fixture('all-day'), 'allday-1@fixture')], new Date('2027-03-29T00:00:00Z'), new Date('2027-03-30T00:00:00Z'))).toEqual([]);
    expect(expand([stored(fixture('all-day'), 'allday-1@fixture')], new Date('2027-03-27T00:00:00Z'), new Date('2027-03-28T00:00:00Z'))).toEqual([]);
  });

  it("event stored in America/New_York shows at correct Berlin wall time across both regions' differing DST dates", () => {
    // Mondays 09:00 in New York from 2027-03-01. The US changes on 2027-03-14, Europe on 2027-03-28.
    const occ = expand(
      [stored(fixture('foreign-tz'), 'foreign-1@fixture')],
      new Date('2027-03-01T00:00:00Z'),
      new Date('2027-04-06T00:00:00Z'),
    );
    expect(occ.map((o) => [o.start.slice(0, 10), o.startUtc.slice(11, 16), wall(o.startUtc, 'Europe/Berlin').slice(11)])).toEqual([
      ['2027-03-01', '14:00', '15:00'], // EST, CET
      ['2027-03-08', '14:00', '15:00'],
      ['2027-03-15', '13:00', '14:00'], // EDT, still CET
      ['2027-03-22', '13:00', '14:00'],
      ['2027-03-29', '13:00', '15:00'], // EDT, CEST
      ['2027-04-05', '13:00', '15:00'],
    ]);
    expect(new Set(occ.map((o) => o.start.slice(11)))).toEqual(new Set(['09:00:00']));
  });

  it('02:30 local on the spring-forward day resolves to 03:30 and does not vanish', () => {
    // Berlin: 2027-03-28 02:00 CET jumps to 03:00 CEST, so 02:30 does not exist; RFC 5545 reads it with the offset
    // before the gap (01:30Z), which is 03:30 CEST. Same for a zone known only from IANA data and from the rules.
    const daily: EventInput = {
      title: 'Night shift',
      start: '2027-03-26T02:30:00',
      end: '2027-03-26T03:00:00',
      allDay: false,
      timeZone: 'Europe/Berlin',
      rrule: 'FREQ=DAILY;COUNT=4',
    };
    const occ = run(daily, '2027-03-25T00:00:00Z', '2027-04-01T00:00:00Z');
    expect(occ.map((o) => o.startUtc)).toEqual([
      '2027-03-26T01:30:00.000Z',
      '2027-03-27T01:30:00.000Z',
      '2027-03-28T01:30:00.000Z',
      '2027-03-29T00:30:00.000Z',
    ]);
    expect(wall(occ[2]!.startUtc, 'Europe/Berlin')).toBe('2027-03-28 03:30');
    // Its end (03:00 local does not shift either: 30 minutes after the start in absolute time).
    expect(occ[2]!.endUtc).toBe('2027-03-28T02:00:00.000Z');
  });
});
