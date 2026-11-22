import ICAL from 'ical.js';

/**
 * Time-zone support on top of ical.js.
 *
 * - A zone that an ICS file defines (VTIMEZONE) is used exactly as defined; ical.js resolves it from the file.
 * - A TZID the file does not define is resolved from the IANA data of the runtime (`Intl`): `intlVTimezone` writes a
 *   VTIMEZONE for it, which is inserted into the parsed file before any time value is read.
 * - ical.js converts a local time to an offset correctly except in the hour around a transition (a local time that
 *   does not exist, or occurs twice). `wallToUtc` handles those two cases the way RFC 5545 3.3.5 says: a local time
 *   in the gap is read with the offset before the gap (02:30 on spring-forward day is 03:30 summer time), a local
 *   time that occurs twice is the first occurrence. ical.js's own UTC-to-local conversion is wrong for the hour
 *   after a transition, so `utcToWall` is built on `wallToUtc` and never on it.
 */

export type Zone = ICAL.Timezone;

const DAY_MS = 86_400_000;

/** A "wall time" is a local date-time written as epoch milliseconds as if it were UTC. */
export function wallMsOf(t: { year: number; month: number; day: number; hour: number; minute: number; second: number }): number {
  return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
}

function isFixedZero(zone: Zone): boolean {
  return zone.tzid === 'UTC' || zone.tzid === 'floating' || zone.tzid === 'Z';
}

/** Offset (seconds east of UTC) that ical.js reads for a wall time. Not transition-safe: use `wallToUtc`. */
function rawOffset(zone: Zone, wallMs: number): number {
  if (isFixedZero(zone)) return 0;
  return zone.utcOffset(ICAL.Time.fromJSDate(new Date(wallMs), true));
}

/** UTC epoch ms of a wall time in `zone`. Gap: offset before the gap. Repeated hour: first occurrence. */
export function wallToUtc(zone: Zone, wallMs: number): number {
  if (isFixedZero(zone)) return wallMs;
  const before = rawOffset(zone, wallMs - DAY_MS);
  const after = rawOffset(zone, wallMs + DAY_MS);
  if (before === after) return wallMs - before * 1000;
  const width = Math.abs(after - before) * 1000;
  const here = rawOffset(zone, wallMs);
  // ical.js switches to the new offset at the first wall time of the gap / repeated hour.
  if (here === after && rawOffset(zone, wallMs - width) === before) return wallMs - before * 1000;
  return wallMs - here * 1000;
}

/** Wall time in `zone` of a UTC instant. */
export function utcToWall(zone: Zone, utcMs: number): number {
  if (isFixedZero(zone)) return utcMs;
  const before = rawOffset(zone, utcMs - DAY_MS);
  const after = rawOffset(zone, utcMs + DAY_MS);
  if (before === after) return utcMs + after * 1000;
  for (const offset of [after, before]) {
    const wall = utcMs + offset * 1000;
    if (wallToUtc(zone, wall) === utcMs) return wall;
  }
  return utcMs + after * 1000; // the second occurrence of a repeated hour
}

// ---------------------------------------------------------------------------------------------------------------
// VTIMEZONE from IANA data (Intl)

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tzid: string): Intl.DateTimeFormat {
  let f = formatters.get(tzid);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tzid, timeZoneName: 'longOffset' });
    formatters.set(tzid, f);
  }
  return f;
}

/** True when the runtime knows `tzid` as an IANA zone. */
export function isIanaZone(tzid: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tzid)) return false;
  try {
    formatterFor(tzid);
    return true;
  } catch {
    return false;
  }
}

/** UTC offset in seconds of an IANA zone at an instant. */
export function ianaOffset(tzid: string, utcMs: number): number {
  const part = formatterFor(tzid)
    .formatToParts(new Date(utcMs))
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /^GMT(?:([+\-−])(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(part ?? '');
  if (!m) throw new Error(`cannot read the UTC offset of ${tzid}`);
  if (!m[1]) return 0;
  const secs = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0);
  return m[1] === '+' ? secs : -secs;
}

export interface Transition {
  /** First instant (UTC ms, whole minutes) with the new offset. */
  atMs: number;
  from: number;
  to: number;
}

const transitionCache = new Map<string, Transition[]>();

/** Offset changes of an IANA zone during the calendar years `fromYear..toYear` (UTC years). */
export function ianaTransitions(tzid: string, fromYear: number, toYear: number): Transition[] {
  const out: Transition[] = [];
  for (let year = fromYear; year <= toYear; year++) {
    const key = `${tzid}|${year}`;
    let list = transitionCache.get(key);
    if (!list) {
      list = [];
      const end = Date.UTC(year + 1, 0, 1);
      let t = Date.UTC(year, 0, 1);
      let offset = ianaOffset(tzid, t);
      while (t < end) {
        const next = Math.min(t + DAY_MS, end);
        const nextOffset = ianaOffset(tzid, next);
        if (nextOffset !== offset && next < end) {
          let lo = t / 60_000;
          let hi = next / 60_000;
          while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (ianaOffset(tzid, mid * 60_000) === offset) lo = mid;
            else hi = mid;
          }
          list.push({ atMs: hi * 60_000, from: offset, to: ianaOffset(tzid, hi * 60_000) });
        }
        t = next;
        offset = nextOffset;
      }
      transitionCache.set(key, list);
    }
    out.push(...list);
  }
  return out;
}

function pad(n: number, len = 2): string {
  return String(Math.abs(n)).padStart(len, '0');
}

function offsetText(sec: number): string {
  const sign = sec < 0 ? '-' : '+';
  const a = Math.abs(sec);
  return `${sign}${pad(Math.floor(a / 3600))}${pad(Math.floor((a % 3600) / 60))}`;
}

function localText(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '');
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

/** The yearly rule ("last Sunday of March") shared by all transitions, or null when they do not follow one. */
function commonRule(list: Array<{ local: number }>): { month: number; byday: string } | null {
  let rule: { month: number; weekday: number; ordinal: number | 'last'; time: number } | undefined;
  let allLast = true;
  const ordinals = new Set<number>();
  for (const { local } of list) {
    const d = new Date(local);
    const month = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), month, 0)).getUTCDate();
    const ordinal = Math.ceil(day / 7);
    const time = local - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day);
    if (day + 7 <= daysInMonth) allLast = false;
    ordinals.add(ordinal);
    if (rule && (rule.month !== month || rule.weekday !== d.getUTCDay() || rule.time !== time)) return null;
    rule ??= { month, weekday: d.getUTCDay(), ordinal, time };
  }
  if (!rule) return null;
  const nth = allLast ? -1 : ordinals.size === 1 ? rule.ordinal : null;
  if (nth === null) return null;
  return { month: rule.month, byday: `${nth}${WEEKDAYS[rule.weekday]}` };
}

/**
 * A VTIMEZONE (text, CRLF lines) for an IANA zone covering the UTC years `fromYear..toYear`.
 * `rules: true` writes yearly RRULEs where the transitions follow one (for files we hand to other clients);
 * otherwise every transition is listed as an RDATE (exact, used for our own expansion).
 */
export function intlVTimezone(tzid: string, fromYear: number, toYear: number, rules: boolean): string {
  const transitions = ianaTransitions(tzid, fromYear, toYear);
  const initial = transitions[0]?.from ?? ianaOffset(tzid, Date.UTC(fromYear, 0, 1));
  const lines: string[] = ['BEGIN:VTIMEZONE', `TZID:${tzid}`];

  const base = (kind: 'STANDARD' | 'DAYLIGHT'): void => {
    lines.push(
      `BEGIN:${kind}`,
      `DTSTART:${localText(Date.UTC(fromYear - 1, 0, 1))}`,
      `TZOFFSETFROM:${offsetText(initial)}`,
      `TZOFFSETTO:${offsetText(initial)}`,
      `END:${kind}`,
    );
  };
  base('STANDARD');

  const groups = new Map<string, Array<{ local: number; from: number; to: number }>>();
  for (const t of transitions) {
    const key = `${t.from}>${t.to}`;
    const list = groups.get(key) ?? [];
    list.push({ local: t.atMs + t.from * 1000, from: t.from, to: t.to });
    groups.set(key, list);
  }
  for (const list of groups.values()) {
    const first = list[0];
    if (!first) continue;
    const kind = first.to > first.from ? 'DAYLIGHT' : 'STANDARD';
    lines.push(
      `BEGIN:${kind}`,
      `DTSTART:${localText(first.local)}`,
      `TZOFFSETFROM:${offsetText(first.from)}`,
      `TZOFFSETTO:${offsetText(first.to)}`,
    );
    const rule = rules && list.length >= 2 ? commonRule(list) : null;
    if (rule) lines.push(`RRULE:FREQ=YEARLY;BYMONTH=${rule.month};BYDAY=${rule.byday}`);
    else for (const e of list.slice(1)) lines.push(`RDATE:${localText(e.local)}`);
    lines.push(`END:${kind}`);
  }
  lines.push('END:VTIMEZONE');
  return lines.join('\r\n');
}
