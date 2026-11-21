import ICAL from 'ical.js';
import { readResource, wallString, type ResourceEvent } from './ical.js';
import { utcToWall, wallMsOf, wallToUtc } from './zones.js';
import type { StoredEvent } from './events-repo.js';

export interface Occurrence {
  calendarId: string;
  uid: string;
  /** '' for a single event; otherwise the original start of the instance (UTC `…Z`, or a date for all-day). */
  recurrenceId: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  /** Zone of `start` / `end`: IANA name, `UTC` or `floating` (all-day events are always `floating`). */
  timeZone: string;
  /** Wall clock in `timeZone` (`YYYY-MM-DDTHH:mm:ss`; all-day: `YYYY-MM-DD`, `end` exclusive). */
  start: string;
  end: string;
  /** ISO instants. All-day: midnight UTC of the date, so the date is the same for every viewer. */
  startUtc: string;
  endUtc: string;
  isOverride: boolean;
  isRecurring: boolean;
  isPrivate: boolean;
}

const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 400;
export const MAX_OCCURRENCES = 2000;
/** Upper bound for ical.js iterations per series (a FREQ=SECONDLY rule must not hang the server). */
const MAX_STEPS = 60_000;

function occurrenceOf(calendarId: string, ev: ResourceEvent, o: { startMs: number; endMs: number; recurrenceId: string; isOverride: boolean }): Occurrence {
  const p = ev.parsed;
  const startWall = p.allDay ? o.startMs : utcToWall(ev.zone, o.startMs);
  const endWall = p.allDay ? o.endMs : utcToWall(ev.zone, o.endMs);
  return {
    calendarId,
    uid: p.uid,
    recurrenceId: o.recurrenceId,
    title: p.title,
    description: p.description,
    location: p.location,
    allDay: p.allDay,
    timeZone: p.timeZone,
    start: wallString(startWall, p.allDay),
    end: wallString(endWall, p.allDay),
    startUtc: new Date(o.startMs).toISOString(),
    endUtc: new Date(o.endMs).toISOString(),
    isOverride: o.isOverride,
    isRecurring: ev.recurring || p.recurrenceId !== '',
    isPrivate: ev.isPrivate,
  };
}

function keyOf(t: ICAL.Time): string {
  if (t.isDate) return wallString(wallMsOf({ year: t.year, month: t.month, day: t.day, hour: 0, minute: 0, second: 0 }), true);
  const utc = wallToUtc(t.zone, wallMsOf(t));
  return `${new Date(utc).toISOString().slice(0, 19)}Z`;
}

/** Start instants (UTC ms) of the instances a master generates, in order, until `stopMs` or `limit` is reached. */
function* instances(master: ResourceEvent, stopMs: number): Generator<{ startMs: number; key: string }> {
  const t0 = master.dtstart;
  const allDay = master.parsed.allDay;
  const startOf = (t: ICAL.Time): number =>
    allDay ? wallMsOf({ year: t.year, month: t.month, day: t.day, hour: 0, minute: 0, second: 0 }) : wallToUtc(t.zone, wallMsOf(t));
  if (!master.recurring) {
    yield { startMs: master.startMs, key: '' };
    return;
  }
  const it = new ICAL.RecurExpansion({ component: master.vevent, dtstart: t0 });
  for (let steps = 0; steps < MAX_STEPS; steps++) {
    const t = it.next();
    if (!t) return;
    const startMs = startOf(t);
    // Wall-clock order and UTC order differ by at most the DST shift; one day of slack is plenty.
    if (startMs > stopMs + DAY_MS) return;
    yield { startMs, key: keyOf(t) };
  }
}

/**
 * Occurrences overlapping `[from, to)` of the events' resources, sorted by start. Events of one resource (master and
 * overrides) may be passed as several rows; they are read from the stored ICS once. The window is capped at 400 days
 * and the result at `max` entries (default 2000). Cancelled events and cancelled overrides are left out.
 */
export function expand(events: StoredEvent[], from: Date, to: Date, max: number = MAX_OCCURRENCES): Occurrence[] {
  const fromMs = from.getTime();
  const toMs = Math.min(to.getTime(), fromMs + MAX_RANGE_DAYS * DAY_MS);
  if (!(toMs > fromMs) || max <= 0) return [];
  const toYear = new Date(toMs).getUTCFullYear() + 1;

  const resources = new Map<string, StoredEvent>();
  for (const row of events) {
    const key = `${row.calendar_id}\u0000${row.uid}`;
    if (!resources.has(key)) resources.set(key, row);
  }

  const inWindow = (startMs: number, endMs: number): boolean => startMs < toMs && Math.max(endMs, startMs + 1) > fromMs;
  const out: Occurrence[] = [];

  for (const row of resources.values()) {
    let resource;
    try {
      resource = readResource(row.ics, { toYear });
    } catch {
      continue; // an unreadable stored resource must not take the whole range down
    }
    const master = resource.events.find((e) => e.parsed.recurrenceId === '');
    const overrides = resource.events.filter((e) => e.parsed.recurrenceId !== '');
    const overridden = new Set(overrides.map((e) => e.parsed.recurrenceId));
    const found: Occurrence[] = [];

    if (master && !master.cancelled) {
      const duration = master.endMs - master.startMs;
      for (const inst of instances(master, toMs)) {
        if (inst.key !== '' && overridden.has(inst.key)) continue;
        const endMs = inst.startMs + duration;
        if (inWindow(inst.startMs, endMs)) {
          found.push(occurrenceOf(row.calendar_id, master, { startMs: inst.startMs, endMs, recurrenceId: inst.key, isOverride: false }));
          if (found.length >= max) break;
        }
      }
    }
    for (const ov of overrides) {
      if (ov.cancelled || (master?.cancelled ?? false)) continue;
      if (inWindow(ov.startMs, ov.endMs)) {
        found.push(occurrenceOf(row.calendar_id, ov, { startMs: ov.startMs, endMs: ov.endMs, recurrenceId: ov.parsed.recurrenceId, isOverride: true }));
      }
    }
    out.push(...found);
  }

  out.sort((a, b) => (a.startUtc < b.startUtc ? -1 : a.startUtc > b.startUtc ? 1 : a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  return out.slice(0, max);
}

/**
 * UTC ms at which the last instance of a master ends, or null when the series has no end (no COUNT/UNTIL, or one so
 * large that it is treated as endless). A single event ends at its own end.
 */
export function seriesEnd(master: ResourceEvent): number | null {
  if (!master.recurring) return master.endMs;
  const rule: unknown = master.vevent.getFirstPropertyValue('rrule');
  const bounded = rule instanceof ICAL.Recur && (rule.count != null || rule.until != null);
  const rdateOnly = rule === null || rule === undefined;
  if (!bounded && !rdateOnly) return null;
  const duration = master.endMs - master.startMs;
  let last: number | null = null;
  let count = 0;
  for (const inst of instances(master, Number.MAX_SAFE_INTEGER - DAY_MS)) {
    last = inst.startMs;
    count++;
  }
  // The iteration cap ends a series of unbounded length early; do not mistake that for its end.
  if (count >= MAX_STEPS) return null;
  return last === null ? master.endMs : last + duration;
}
