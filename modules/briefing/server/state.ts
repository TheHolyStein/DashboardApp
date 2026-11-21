import type { EventPayload } from '@dash/contract';
import type { AgendaEvent } from '../manifest.js';
import { localDate } from './compose.js';

/** Hard bounds: whatever the sources send, one user's stored state never grows past these. */
export const MAX_ALERTS = 5;
export const MAX_PINS = 20;
export const MAX_EVENTS = 50;
export const MAX_DUE = 50;
const MAX_TITLE = 200;

export interface WeatherState {
  condition: EventPayload<'weather.updated'>['condition'];
  tempC: number;
  nextPrecip: { at: string; mm: number } | null;
  pollenMax: number | null;
  /** When the update arrived (ISO). A forecast older than a few hours is not trusted. */
  at: string;
}

/** Household-wide conditions: the events carry no user, so they belong to everyone's briefing. */
export interface SystemState {
  netOffline?: { since: string };
  nas?: { status: 'degraded' | 'failed'; detail: string; at: string };
}

export interface Pin {
  key: string;
  title: string;
  /** Local date (YYYY-MM-DD) on which the pin shows; it is dropped when that date has passed. */
  date: string;
}

export interface AlertEntry {
  id: string;
  level: 'warn' | 'critical';
  title: string;
  /** When the notification was created (ISO). */
  at: string;
}

/**
 * Everything the briefing knows about one user: the LAST summary of each source (never a history), the soonest
 * upcoming event, pins and alerts. `weather` and `system` are household-wide: they are not stored per user but
 * merged in when the briefing is composed.
 */
export interface UserState {
  calendar?: { date: string; events: AgendaEvent[] };
  upcoming?: { title: string; start: string };
  todo?: { date: string; overdue: number; due: Array<{ title: string; list: string }> };
  pins: Pin[];
  alerts: AlertEntry[];
  weather?: WeatherState;
  system?: SystemState;
}

export const emptyState = (): UserState => ({ pins: [], alerts: [] });

/** The part of a state that is stored under the user's own key. */
export const ownPart = (s: UserState): UserState => {
  const own: UserState = { pins: s.pins, alerts: s.alerts };
  if (s.calendar) own.calendar = s.calendar;
  if (s.upcoming) own.upcoming = s.upcoming;
  if (s.todo) own.todo = s.todo;
  return own;
};

const cut = (s: string): string => (s.length > MAX_TITLE ? s.slice(0, MAX_TITLE) : s);

/** YYYY-MM-DD from a date or date-time string, else null. */
export function dateOnly(s: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(s);
  return m ? (m[1] ?? null) : null;
}

export function withCalendar(s: UserState, p: EventPayload<'calendar.day.summary'>): UserState {
  const events = p.events.slice(0, MAX_EVENTS).map((e) => ({
    uid: e.uid,
    title: cut(e.title),
    start: e.start,
    end: e.end,
    allDay: e.allDay,
  }));
  return { ...s, calendar: { date: p.date, events } };
}

/** Keeps the soonest event that has not started; an event that already started never replaces anything. */
export function withUpcoming(s: UserState, p: EventPayload<'calendar.event.upcoming'>, nowMs: number): UserState {
  const start = Date.parse(p.start);
  if (Number.isNaN(start) || start <= nowMs) return s;
  const stored = s.upcoming ? Date.parse(s.upcoming.start) : Number.NaN;
  if (s.upcoming && stored > nowMs && stored <= start) return s;
  return { ...s, upcoming: { title: cut(p.title), start: p.start } };
}

export function withTodos(s: UserState, p: EventPayload<'todo.day.summary'>): UserState {
  return {
    ...s,
    todo: {
      date: p.date,
      overdue: Math.max(0, Math.trunc(p.overdue)),
      due: p.due.slice(0, MAX_DUE).map((d) => ({ title: cut(d.title), list: d.list })),
    },
  };
}

/** Same `sourceKey` replaces the pin; an unparseable date is ignored; at most MAX_PINS, the soonest dates win. */
export function withPin(s: UserState, p: EventPayload<'pin.request'>, today: string): UserState {
  const date = dateOnly(p.date);
  if (date === null || date < today) return s;
  const pins = [...s.pins.filter((x) => x.key !== p.sourceKey), { key: p.sourceKey, title: cut(p.title), date }];
  pins.sort((a, b) => a.date.localeCompare(b.date));
  return { ...s, pins: pins.slice(0, MAX_PINS) };
}

/** Only warn and critical count. The same notification id (a deduped update) replaces its entry. Newest 5 are kept. */
export function withAlert(s: UserState, p: EventPayload<'notification.created'>): UserState {
  if (p.level === 'info') return s;
  const alerts = [...s.alerts.filter((a) => a.id !== p.id), { id: p.id, level: p.level, title: cut(p.title), at: p.createdAt }];
  alerts.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { ...s, alerts: alerts.slice(0, MAX_ALERTS) };
}

const DAY_MS = 24 * 3600 * 1000;
export const ALERT_WINDOW_MS = DAY_MS;

/** Drops what can no longer show: pins whose date has passed, alerts older than 24 h, summaries of earlier days. */
export function prune(s: UserState, now: Date, tz: string): UserState {
  const today = localDate(now, tz);
  const next: UserState = {
    ...s,
    pins: s.pins.filter((p) => p.date >= today),
    alerts: s.alerts.filter((a) => now.getTime() - Date.parse(a.at) < ALERT_WINDOW_MS),
  };
  if (s.calendar && s.calendar.date < today) delete next.calendar;
  if (s.todo && s.todo.date < today) delete next.todo;
  if (s.upcoming && Date.parse(s.upcoming.start) <= now.getTime()) delete next.upcoming;
  return next;
}
