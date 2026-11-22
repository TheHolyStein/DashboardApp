import type { Translate } from '@dash/contract';

/** What the client needs of an occurrence (the snapshot's lite form and the full DTO both have it). */
export interface OccLike {
  uid: string;
  calendarId: string;
  recurrenceId: string | null;
  displayTitle: string;
  start: string;
  end: string;
  startUtc: string;
  endUtc: string;
  allDay: boolean;
  timeZone: string;
  color: string;
  tags: string[];
  mentions: string[];
}

const DAY_MS = 86_400_000;
/** Height of one minute in the time grid. */
export const PX_PER_MIN = 0.8;

export function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();
function wallFormatter(tz: string): Intl.DateTimeFormat {
  let f = wallFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    wallFormatters.set(tz, f);
  }
  return f;
}

/** `YYYY-MM-DDTHH:mm:ss` wall clock of an instant in a zone (`UTC` and `floating` read the instant as is). */
export function wallOf(ms: number, timeZone: string): string {
  if (timeZone === 'UTC' || timeZone === 'floating') return new Date(ms).toISOString().slice(0, 19);
  const parts = Object.fromEntries(wallFormatter(safeZone(timeZone)).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:${parts['second']}`;
}

/** Local `YYYY-MM-DD` of an instant. */
export const localDay = (ms: number, timeZone: string): string => wallOf(ms, timeZone).slice(0, 10);

export const addDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** 0 = Sunday … 6 = Saturday. */
export const weekday = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

export function startOfWeek(date: string, weekStart: 'mon' | 'sun'): string {
  const first = weekStart === 'mon' ? 1 : 0;
  return addDays(date, -((weekday(date) - first + 7) % 7));
}

/** The 42 dates of a six-row month grid. `month` is `YYYY-MM`. */
export function monthGrid(month: string, weekStart: 'mon' | 'sun'): string[] {
  const first = startOfWeek(`${month}-01`, weekStart);
  return Array.from({ length: 42 }, (_, i) => addDays(first, i));
}

/**
 * Wall clock of an occurrence's start / end for a viewer: floating events keep their own wall clock, all others are
 * converted from their instants.
 */
export function viewerWall(o: OccLike, which: 'start' | 'end', viewerZone: string): string {
  if (o.allDay) return `${which === 'start' ? o.start : o.end}T00:00:00`;
  if (o.timeZone === 'floating') return which === 'start' ? o.start : o.end;
  return wallOf(Date.parse(which === 'start' ? o.startUtc : o.endUtc), viewerZone);
}

/** Whether an occurrence touches a local date for the viewer (all-day: `end` is exclusive). */
export function touches(o: OccLike, date: string, viewerZone: string): boolean {
  if (o.allDay) return o.start <= date && date < o.end;
  const s = viewerWall(o, 'start', viewerZone);
  const e = viewerWall(o, 'end', viewerZone);
  const lo = `${date}T00:00:00`;
  const hi = `${addDays(date, 1)}T00:00:00`;
  return s < hi && (e > lo || (e === s && s >= lo));
}

/** Local start date of an occurrence for the viewer. */
export const startDay = (o: OccLike, viewerZone: string): string => (o.allDay ? o.start : viewerWall(o, 'start', viewerZone).slice(0, 10));

/** All-day first, then by start. */
export function byStart(a: OccLike, b: OccLike): number {
  return Number(b.allDay) - Number(a.allDay) || (a.startUtc < b.startUtc ? -1 : a.startUtc > b.startUtc ? 1 : a.uid < b.uid ? -1 : 1);
}

/** Occurrences grouped by their local start date, in date order. */
export function groupByDay<T extends OccLike>(items: T[], viewerZone: string): Array<{ date: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const o of [...items].sort(byStart)) {
    const d = startDay(o, viewerZone);
    const list = groups.get(d) ?? [];
    list.push(o);
    groups.set(d, list);
  }
  return [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, list]) => ({ date, items: list }));
}

/** "Today", "Tomorrow" or a formatted date. `today` is the viewer's local date. */
export function dayLabel(date: string, today: string, opts: { locale: string; t: Translate }): { text: string; isWord: boolean } {
  if (date === today) return { text: opts.t('m.calendar.today', 'Today'), isWord: true };
  if (date === addDays(today, 1)) return { text: opts.t('m.calendar.tomorrow', 'Tomorrow'), isWord: true };
  const text = new Intl.DateTimeFormat(opts.locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  );
  return { text, isWord: false };
}

/** Time of day of a wall clock string, in the locale's style. */
export function formatClock(wall: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(`${wall.slice(0, 19)}Z`));
}

/** "Mo", "Di", … for the grid header, starting at the week start. */
export function weekdayNames(locale: string, weekStart: 'mon' | 'sun'): string[] {
  const first = weekStart === 'mon' ? '2027-01-04' : '2027-01-03';
  const f = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(`${addDays(first, i)}T00:00:00Z`)));
}

/** Minutes since local midnight of a wall clock string. */
export const minuteOfDay = (wall: string): number => Number(wall.slice(11, 13)) * 60 + Number(wall.slice(14, 16));

/** A wall clock moved by whole minutes (string arithmetic as UTC: wall clocks have no zone). */
export const shiftWall = (wall: string, minutes: number): string =>
  new Date(Date.parse(`${wall.slice(0, 19)}Z`) + minutes * 60_000).toISOString().slice(0, 19);

/**
 * New start / end wall clocks, in the event's own zone, after moving an occurrence by `deltaMin` and stretching its
 * end by `resizeMin`.
 */
export function movedTimes(o: OccLike, deltaMin: number, resizeMin = 0): { start: string; end: string } {
  if (o.timeZone === 'floating') return { start: shiftWall(o.start, deltaMin), end: shiftWall(o.end, deltaMin + resizeMin) };
  const s = Date.parse(o.startUtc) + deltaMin * 60_000;
  const e = Date.parse(o.endUtc) + (deltaMin + resizeMin) * 60_000;
  return { start: wallOf(s, o.timeZone), end: wallOf(Math.max(e, s + 15 * 60_000), o.timeZone) };
}

/** Minutes between two wall clocks (`b − a`). */
export const wallDiffMin = (a: string, b: string): number =>
  Math.round((Date.parse(`${b.length === 10 ? `${b}T00:00:00` : b.slice(0, 19)}Z`) - Date.parse(`${a.length === 10 ? `${a}T00:00:00` : a.slice(0, 19)}Z`)) / 60_000);

/** A wall clock or date moved by whole minutes, keeping its form. */
export const shiftAny = (wall: string, minutes: number): string =>
  wall.length === 10 ? shiftWall(`${wall}T00:00:00`, minutes).slice(0, 10) : shiftWall(wall, minutes);
