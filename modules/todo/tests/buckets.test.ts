import { describe, expect, it } from 'vitest';
import { addInterval, bucketOf, endOfIsoWeek, endOfMonth, localDate } from '../server/buckets.js';

const due = (iso: string | null) => ({ due: iso });

describe('bucketOf', () => {
  it('bucketOf across week and month boundaries', () => {
    // Wednesday 2026-11-18 10:00 in Berlin (09:00 UTC); ISO week ends Sunday 2026-11-22; month ends 2026-11-30.
    const now = new Date('2026-11-18T09:00:00Z');
    const tz = 'Europe/Berlin';
    const at = (iso: string | null) => bucketOf(due(iso), now, tz);
    expect(at(null)).toBe('none');
    expect(at('2026-11-18T08:59:00Z')).toBe('overdue');
    expect(at('2026-11-18T09:00:00Z')).toBe('today'); // exactly now is not yet overdue
    expect(at('2026-11-18T22:59:00Z')).toBe('today'); // 23:59 Berlin
    expect(at('2026-11-18T23:30:00Z')).toBe('week'); // 00:30 Thursday Berlin
    expect(at('2026-11-22T22:59:00Z')).toBe('week'); // Sunday 23:59 Berlin
    expect(at('2026-11-22T23:00:00Z')).toBe('month'); // Monday 00:00 Berlin
    expect(at('2026-11-30T22:59:00Z')).toBe('month');
    expect(at('2026-11-30T23:00:00Z')).toBe('later'); // 1 December Berlin
  });

  it('uses the time zone for the day boundary, not UTC', () => {
    const now = new Date('2026-11-18T23:30:00Z'); // 05:00 on the 19th in Kolkata
    expect(bucketOf(due('2026-11-19T10:00:00Z'), now, 'Asia/Kolkata')).toBe('today');
    expect(bucketOf(due('2026-11-19T10:00:00Z'), now, 'UTC')).toBe('week');
  });

  it('a month boundary inside the week counts as week first', () => {
    const now = new Date('2026-12-30T12:00:00Z'); // Wednesday; week ends Sunday 2027-01-03
    expect(bucketOf(due('2027-01-02T12:00:00Z'), now, 'UTC')).toBe('week');
    expect(bucketOf(due('2027-01-04T12:00:00Z'), now, 'UTC')).toBe('later');
  });
});

describe('period ends', () => {
  it('week item without due gets Sunday 23:59 local (helper)', () => {
    expect(endOfIsoWeek(new Date('2026-11-18T09:00:00Z'), 'Europe/Berlin').toISOString()).toBe('2026-11-22T22:59:00.000Z');
    expect(endOfIsoWeek(new Date('2026-11-22T20:00:00Z'), 'UTC').toISOString()).toBe('2026-11-22T23:59:00.000Z'); // Sunday itself
    expect(endOfIsoWeek(new Date('2026-11-23T00:10:00Z'), 'UTC').toISOString()).toBe('2026-11-29T23:59:00.000Z'); // Monday
  });
  it('month ends on the last local day at 23:59, across summer time', () => {
    expect(endOfMonth(new Date('2026-03-10T12:00:00Z'), 'Europe/Berlin').toISOString()).toBe('2026-03-31T21:59:00.000Z');
    expect(endOfMonth(new Date('2026-02-10T12:00:00Z'), 'UTC').toISOString()).toBe('2026-02-28T23:59:00.000Z');
  });
  it('localDate formats the local calendar day', () => {
    expect(localDate(new Date('2026-11-18T23:30:00Z'), 'Asia/Kolkata')).toBe('2026-11-19');
  });
});

describe('addInterval around DST', () => {
  const berlin = 'Europe/Berlin';
  it('a wall-clock time inside the spring-forward gap moves forward, the next day is back at that time', () => {
    const due = new Date('2026-03-28T01:30:00Z'); // 02:30 CET
    // 2026-03-29 02:30 does not exist in Berlin: the clock jumps 02:00 -> 03:00
    expect(addInterval(due, 1, 'day', berlin).toISOString()).toBe('2026-03-29T01:30:00.000Z'); // 03:30 CEST
    expect(addInterval(due, 2, 'day', berlin).toISOString()).toBe('2026-03-30T00:30:00.000Z'); // 02:30 CEST
    expect(addInterval(due, 1, 'week', berlin).toISOString()).toBe('2026-04-04T00:30:00.000Z');
  });
  it('a day step across the fall-back keeps the wall-clock time', () => {
    const due = new Date('2026-10-24T09:00:00Z'); // 11:00 CEST
    expect(addInterval(due, 1, 'day', berlin).toISOString()).toBe('2026-10-25T10:00:00.000Z'); // 11:00 CET
  });
  it('a month step keeps the anchor day', () => {
    expect(addInterval(new Date('2026-02-28T10:00:00Z'), 1, 'month', 'UTC', 31).toISOString()).toBe('2026-03-31T10:00:00.000Z');
    expect(addInterval(new Date('2026-01-31T10:00:00Z'), 1, 'month', 'UTC', 31).toISOString()).toBe('2026-02-28T10:00:00.000Z');
  });
});
