import { describe, expect, test } from 'vitest';
import { compose, localDate } from '../server/compose.js';
import { emptyState, type UserState } from '../server/state.js';

const TZ = 'Europe/Berlin';
const NOW = new Date('2026-11-12T07:30:00.000Z'); // 08:30 in Berlin

const ev = (uid: string, title: string, start: string, over: Partial<{ end: string; allDay: boolean }> = {}) => ({
  uid,
  title,
  start,
  end: over.end ?? start,
  allDay: over.allDay ?? false,
});

function sample(): UserState {
  return {
    calendar: {
      date: '2026-11-12',
      events: [
        ev('e0', 'Bin day', '2026-11-12', { allDay: true }),
        ev('e1', 'Early call', '2026-11-12T06:00:00.000Z'), // already over
        ev('e2', 'Standup', '2026-11-12T08:00:00.000Z'), // 30 min away
        ev('e3', 'Dentist', '2026-11-12T13:00:00.000Z'),
      ],
    },
    upcoming: { title: 'Standup', start: '2026-11-12T08:00:00.000Z' },
    todo: {
      date: '2026-11-12',
      overdue: 1,
      due: [
        { title: 'Pay rent', list: 'deadline' },
        { title: 'Milk', list: 'shopping' },
      ],
    },
    pins: [
      { key: 'p1', title: 'Anna birthday', date: '2026-11-12' },
      { key: 'p2', title: 'Tomorrow thing', date: '2026-11-13' },
    ],
    alerts: [
      { id: 'a1', level: 'warn', title: 'Disk 90% full', at: '2026-11-12T06:00:00.000Z' },
      { id: 'a2', level: 'critical', title: 'Smoke alarm', at: '2026-11-12T05:00:00.000Z' },
      { id: 'a3', level: 'warn', title: 'Old news', at: '2026-11-11T06:00:00.000Z' }, // 25.5 h old
    ],
    weather: {
      condition: 'cloudy',
      tempC: 8,
      nextPrecip: { at: '2026-11-12T10:00:00.000Z', mm: 1.2 },
      pollenMax: 2,
      at: '2026-11-12T07:00:00.000Z',
    },
    system: { nas: { status: 'degraded', detail: 'disk 2 slow', at: '2026-11-12T07:00:00.000Z' } },
  };
}

describe('compose', () => {
  test('composes full snapshot from sample state with exact values', () => {
    expect(compose(sample(), NOW, TZ)).toEqual({
      greeting: 'morning',
      date: '2026-11-12',
      next: { title: 'Standup', start: '2026-11-12T08:00:00.000Z', minutesUntil: 30 },
      eventsToday: 4,
      todos: {
        due: [
          { title: 'Pay rent', list: 'deadline' },
          { title: 'Milk', list: 'shopping' },
        ],
        overdue: 1,
      },
      weatherHint: { key: 'rainAt', vars: { at: '2026-11-12T10:00:00.000Z', mm: 1.2 } },
      pins: [{ key: 'p1', title: 'Anna birthday' }],
      alerts: [
        { level: 'critical', title: 'Smoke alarm' },
        { level: 'warn', title: '', kind: 'nasDegraded', vars: { detail: 'disk 2 slow' } },
        { level: 'warn', title: 'Disk 90% full' },
      ],
    });
  });

  test('works with only weather known', () => {
    const state: UserState = { ...emptyState(), weather: sample().weather! };
    expect(compose(state, NOW, TZ)).toEqual({
      greeting: 'morning',
      date: '2026-11-12',
      next: null,
      eventsToday: 0,
      todos: { due: [], overdue: 0 },
      weatherHint: { key: 'rainAt', vars: { at: '2026-11-12T10:00:00.000Z', mm: 1.2 } },
      pins: [],
      alerts: [],
    });
  });

  test('works with nothing known', () => {
    expect(compose(emptyState(), NOW, TZ)).toEqual({
      greeting: 'morning',
      date: '2026-11-12',
      next: null,
      eventsToday: 0,
      todos: { due: [], overdue: 0 },
      weatherHint: null,
      pins: [],
      alerts: [],
    });
  });

  test('pin disappears next day', () => {
    const state: UserState = { ...emptyState(), pins: [{ key: 'p', title: 'Anna birthday', date: '2026-11-12' }] };
    expect(compose(state, new Date('2026-11-12T22:59:00.000Z'), TZ).pins).toEqual([{ key: 'p', title: 'Anna birthday' }]); // 23:59 on the 12th
    expect(compose(state, new Date('2026-11-12T23:00:00.000Z'), TZ).pins).toEqual([]); // 00:00 on the 13th
    expect(compose(state, new Date('2026-11-13T07:30:00.000Z'), TZ).pins).toEqual([]);
  });

  describe('weather hint priority', () => {
    const weather = (over: Partial<NonNullable<UserState['weather']>>): UserState => ({
      ...emptyState(),
      weather: {
        condition: 'clear',
        tempC: 15,
        nextPrecip: null,
        pollenMax: null,
        at: '2026-11-12T07:00:00.000Z',
        ...over,
      },
    });
    const hint = (s: UserState) => compose(s, NOW, TZ).weatherHint?.key;
    const rain = { at: '2026-11-12T12:00:00.000Z', mm: 2 };

    test('hint priority storm over rain', () => {
      expect(hint(weather({ condition: 'storm', nextPrecip: rain, tempC: -3, pollenMax: 5 }))).toBe('storm');
      expect(hint(weather({ condition: 'rain', nextPrecip: rain, tempC: -3, pollenMax: 5 }))).toBe('rainAt');
    });

    test('hint priority continues rain, frost, hot, pollen, dry', () => {
      expect(hint(weather({ tempC: 0, pollenMax: 5 }))).toBe('frost');
      expect(hint(weather({ tempC: 30, pollenMax: 5 }))).toBe('hot');
      expect(hint(weather({ pollenMax: 4 }))).toBe('pollenHigh');
      expect(hint(weather({ pollenMax: 3 }))).toBe('dry');
      expect(hint(weather({}))).toBe('dry');
      expect(compose(weather({ tempC: 0 }), NOW, TZ).weatherHint).toEqual({ key: 'frost', vars: { tempC: 0 } });
      expect(compose(weather({ pollenMax: 5 }), NOW, TZ).weatherHint).toEqual({ key: 'pollenHigh', vars: { level: 5 } });
    });

    test('rain counts only within the next 12 hours, and not when already past', () => {
      expect(hint(weather({ nextPrecip: { at: '2026-11-12T19:30:00.000Z', mm: 1 } }))).toBe('rainAt'); // exactly 12 h
      expect(hint(weather({ nextPrecip: { at: '2026-11-12T19:30:01.000Z', mm: 1 } }))).toBe('dry');
      expect(hint(weather({ nextPrecip: { at: '2026-11-12T07:00:00.000Z', mm: 1 } }))).toBe('dry');
    });

    test('a weather update older than 6 hours gives no hint', () => {
      expect(hint(weather({ at: '2026-11-12T01:29:00.000Z' }))).toBeUndefined();
      expect(hint(weather({ at: '2026-11-12T01:30:00.000Z' }))).toBe('dry');
    });
  });

  describe('greeting by local hour', () => {
    const at = (iso: string) => compose(emptyState(), new Date(iso), 'UTC').greeting;
    test('boundaries 5, 11, 17, 22', () => {
      expect(at('2026-11-12T04:59:00.000Z')).toBe('night');
      expect(at('2026-11-12T05:00:00.000Z')).toBe('morning');
      expect(at('2026-11-12T10:59:00.000Z')).toBe('morning');
      expect(at('2026-11-12T11:00:00.000Z')).toBe('day');
      expect(at('2026-11-12T16:59:00.000Z')).toBe('day');
      expect(at('2026-11-12T17:00:00.000Z')).toBe('evening');
      expect(at('2026-11-12T21:59:00.000Z')).toBe('evening');
      expect(at('2026-11-12T22:00:00.000Z')).toBe('night');
    });

    test('midnight is night and uses the given time zone', () => {
      expect(compose(emptyState(), new Date('2026-11-12T00:00:00.000Z'), 'UTC').greeting).toBe('night');
      expect(compose(emptyState(), new Date('2026-11-12T00:00:00.000Z'), 'Asia/Kolkata').greeting).toBe('morning'); // 05:30
    });
  });

  describe('sections from other days', () => {
    test('a summary of another day is not today', () => {
      const state: UserState = {
        ...emptyState(),
        calendar: { date: '2026-11-11', events: [ev('e', 'Yesterday', '2026-11-12T09:00:00.000Z')] },
        todo: { date: '2026-11-11', overdue: 3, due: [{ title: 'Old', list: 'week' }] },
      };
      const out = compose(state, NOW, TZ);
      expect(out.eventsToday).toBe(0);
      expect(out.next).toBeNull();
      expect(out.todos).toEqual({ due: [], overdue: 0 });
    });

    test('next is the soonest of the agenda and the upcoming event, never one that started', () => {
      const state: UserState = {
        ...emptyState(),
        calendar: { date: '2026-11-12', events: [ev('e', 'Late', '2026-11-12T15:00:00.000Z'), ev('s', 'Started', '2026-11-12T07:00:00.000Z')] },
        upcoming: { title: 'Soon', start: '2026-11-12T07:45:30.000Z' },
      };
      expect(compose(state, NOW, TZ).next).toEqual({ title: 'Soon', start: '2026-11-12T07:45:30.000Z', minutesUntil: 16 });
      expect(compose({ ...state, upcoming: { title: 'Gone', start: '2026-11-12T07:00:00.000Z' } }, NOW, TZ).next?.title).toBe('Late');
    });

    test('an all-day event is counted but is never the next event', () => {
      const state: UserState = {
        ...emptyState(),
        calendar: { date: '2026-11-12', events: [ev('e', 'Holiday', '2026-11-12', { allDay: true })] },
      };
      const out = compose(state, NOW, TZ);
      expect(out.eventsToday).toBe(1);
      expect(out.next).toBeNull();
    });
  });

  test('at most 5 alerts, critical first then newest, system conditions included', () => {
    const state: UserState = {
      ...emptyState(),
      alerts: [1, 2, 3, 4, 5].map((i) => ({ id: `a${i}`, level: 'warn' as const, title: `W${i}`, at: `2026-11-12T0${i}:00:00.000Z` })),
      system: { netOffline: { since: '2026-11-12T00:30:00.000Z' } },
    };
    const titles = compose(state, NOW, TZ).alerts.map((a) => a.kind ?? a.title);
    expect(titles).toEqual(['netOffline', 'W5', 'W4', 'W3', 'W2']);
  });

  test('localDate follows the time zone and survives an unknown one', () => {
    expect(localDate(new Date('2026-11-12T23:30:00.000Z'), 'Asia/Tokyo')).toBe('2026-11-13');
    expect(localDate(new Date('2026-11-12T23:30:00.000Z'), 'Mars/Base')).toBe('2026-11-12');
  });
});
