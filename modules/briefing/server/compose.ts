import type { AgendaEvent, AlertView, Briefing, DayDetail, WeatherHint } from '../manifest.js';
import { ALERT_WINDOW_MS, MAX_ALERTS, type UserState } from './state.js';

const RAIN_WINDOW_MS = 12 * 3600 * 1000;
/** Deliberate rule: a weather update older than 6 h is not trusted any more; no hint is better than a wrong one. */
export const WEATHER_MAX_AGE_MS = 6 * 3600 * 1000;
const POLLEN_HIGH = 4;
const HOT_C = 30;
const FROST_C = 0;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Parts formatter for a zone; an unknown zone falls back to UTC. */
function formatterFor(tz: string): Intl.DateTimeFormat {
  const cached = formatters.get(tz);
  if (cached) return cached;
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return formatterFor('UTC');
  }
  formatters.set(tz, f);
  return f;
}

function localParts(now: Date, tz: string): { date: string; hour: number } {
  const parts = formatterFor(tz).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

/** The calendar date (YYYY-MM-DD) it is right now in `tz`. */
export const localDate = (now: Date, tz: string): string => localParts(now, tz).date;

/** The calendar date after `date`. */
export function nextDate(date: string): string {
  const d = new Date(`${date}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function greetingAt(hour: number): Briefing['greeting'] {
  if (hour >= 5 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 17) return 'day';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

function weatherHint(state: UserState, nowMs: number): WeatherHint | null {
  const w = state.weather;
  if (!w) return null;
  const age = nowMs - Date.parse(w.at);
  if (Number.isNaN(age) || age > WEATHER_MAX_AGE_MS) return null;
  if (w.condition === 'storm') return { key: 'storm', vars: {} };
  if (w.nextPrecip) {
    const until = Date.parse(w.nextPrecip.at) - nowMs;
    if (until >= 0 && until <= RAIN_WINDOW_MS) return { key: 'rainAt', vars: { at: w.nextPrecip.at, mm: w.nextPrecip.mm } };
  }
  // The weather event carries the current temperature only, so it stands in for the day's minimum and maximum.
  if (w.tempC <= FROST_C) return { key: 'frost', vars: { tempC: w.tempC } };
  if (w.tempC >= HOT_C) return { key: 'hot', vars: { tempC: w.tempC } };
  if (w.pollenMax !== null && w.pollenMax >= POLLEN_HIGH) return { key: 'pollenHigh', vars: { level: w.pollenMax } };
  return { key: 'dry', vars: {} };
}

type Alert = AlertView & { at: number };

/** Notification alerts of the last 24 h plus the household conditions that are bad right now, critical first, newest first. */
function alertsOf(state: UserState, nowMs: number): AlertView[] {
  const all: Alert[] = state.alerts
    .filter((a) => nowMs - Date.parse(a.at) < ALERT_WINDOW_MS)
    .map((a): Alert => ({ level: a.level, title: a.title, at: Date.parse(a.at) }));
  const sys = state.system;
  if (sys?.netOffline) all.push({ level: 'critical', title: '', kind: 'netOffline', at: Date.parse(sys.netOffline.since) });
  if (sys?.nas) {
    all.push({
      level: sys.nas.status === 'failed' ? 'critical' : 'warn',
      title: '',
      kind: sys.nas.status === 'failed' ? 'nasFailed' : 'nasDegraded',
      ...(sys.nas.detail ? { vars: { detail: sys.nas.detail } } : {}),
      at: Date.parse(sys.nas.at),
    });
  }
  const seen = new Set<string>();
  const unique = all.filter((a) => {
    const key = `${a.level}\u0000${a.kind ?? ''}\u0000${a.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => (a.level === b.level ? 0 : a.level === 'critical' ? -1 : 1) || b.at - a.at);
  return unique.slice(0, MAX_ALERTS).map((a) => {
    const view: AlertView = { level: a.level, title: a.title };
    if (a.kind) view.kind = a.kind;
    if (a.vars) view.vars = a.vars;
    return view;
  });
}

/** Events of the stored agenda that fall on `date` (a summary of another day contributes nothing). */
function agendaOf(state: UserState, date: string): AgendaEvent[] {
  return state.calendar && state.calendar.date === date ? state.calendar.events : [];
}

function nextEvent(state: UserState, today: string, nowMs: number): Briefing['next'] {
  let best: { title: string; start: string; ms: number } | null = null;
  const consider = (title: string, start: string): void => {
    const ms = Date.parse(start);
    if (Number.isNaN(ms) || ms <= nowMs) return;
    if (!best || ms < best.ms) best = { title, start, ms };
  };
  for (const e of agendaOf(state, today)) if (!e.allDay) consider(e.title, e.start);
  if (state.upcoming) consider(state.upcoming.title, state.upcoming.start);
  const found = best as { title: string; start: string; ms: number } | null;
  return found ? { title: found.title, start: found.start, minutesUntil: Math.ceil((found.ms - nowMs) / 60_000) } : null;
}

const todosOf = (state: UserState, today: string): Briefing['todos'] =>
  state.todo && state.todo.date === today
    ? { due: state.todo.due.map((d) => ({ title: d.title, list: d.list })), overdue: state.todo.overdue }
    : { due: [], overdue: 0 };

/**
 * The briefing of one user at `now` in time zone `tz`. Pure: no I/O, no clock, no randomness. Every source may be
 * missing; its section is then empty (or null). Summaries and pins that belong to another day do not show.
 */
export function compose(state: UserState, now: Date, tz: string): Briefing {
  const nowMs = now.getTime();
  const { date, hour } = localParts(now, tz);
  return {
    greeting: greetingAt(hour),
    date,
    next: nextEvent(state, date, nowMs),
    eventsToday: agendaOf(state, date).length,
    todos: todosOf(state, date),
    weatherHint: weatherHint(state, nowMs),
    pins: state.pins.filter((p) => p.date === date).map((p) => ({ key: p.key, title: p.title })),
    alerts: alertsOf(state, nowMs),
  };
}

/** What the detail pane shows: the full agenda of today and tomorrow, all due todos and the alerts. */
export function composeDay(state: UserState, now: Date, tz: string): Omit<DayDetail, 'epoch' | 'rev'> {
  const date = localDate(now, tz);
  return {
    date,
    today: agendaOf(state, date),
    tomorrow: agendaOf(state, nextDate(date)),
    todos: todosOf(state, date),
    alerts: alertsOf(state, now.getTime()),
  };
}
