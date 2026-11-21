import type { Bucket, RepeatUnit } from '../manifest.js';

/** Local calendar and clock parts of an instant in a zone. `wd` is the ISO weekday, 1 = Monday .. 7 = Sunday. */
export interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  wd: number;
}

export interface Zone {
  parts(ms: number): Parts;
  /** The instant at which the zone's wall clock reads the given local time. */
  toUtc(y: number, m: number, d: number, h: number, mi: number): number;
}

/** An unknown zone name falls back to UTC instead of throwing. */
export function makeZone(timeZone: string): Zone {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
  }
  const read = (ms: number): { y: number; m: number; d: number; h: number; mi: number; s: number } => {
    const o = { y: 0, m: 0, d: 0, h: 0, mi: 0, s: 0 };
    for (const p of fmt.formatToParts(new Date(ms))) {
      const v = Number(p.value);
      if (p.type === 'year') o.y = v;
      else if (p.type === 'month') o.m = v;
      else if (p.type === 'day') o.d = v;
      else if (p.type === 'hour') o.h = v;
      else if (p.type === 'minute') o.mi = v;
      else if (p.type === 'second') o.s = v;
    }
    return o;
  };
  const offset = (ms: number): number => {
    const p = read(ms);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
  };
  return {
    parts(ms) {
      const p = read(ms);
      const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
      return { y: p.y, m: p.m, d: p.d, h: p.h, mi: p.mi, wd: dow === 0 ? 7 : dow };
    },
    toUtc(y, m, d, h, mi) {
      const wall = Date.UTC(y, m - 1, d, h, mi);
      let guess = wall - offset(wall);
      const again = offset(guess);
      if (wall - again !== guess) guess = wall - again;
      return guess;
    },
  };
}

const END_H = 23;
const END_MI = 59;

/** `YYYY-MM-DD` of the local calendar day. */
export function localDate(at: Date, timeZone: string): string {
  const p = makeZone(timeZone).parts(at.getTime());
  return `${String(p.y).padStart(4, '0')}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Sunday 23:59 local of the ISO week (Monday-based) that contains `now`. */
export function endOfIsoWeek(now: Date, timeZone: string): Date {
  const z = makeZone(timeZone);
  const p = z.parts(now.getTime());
  const sunday = new Date(Date.UTC(p.y, p.m - 1, p.d + (7 - p.wd)));
  return new Date(z.toUtc(sunday.getUTCFullYear(), sunday.getUTCMonth() + 1, sunday.getUTCDate(), END_H, END_MI));
}

/** The last day of the month 23:59 local. */
export function endOfMonth(now: Date, timeZone: string): Date {
  const z = makeZone(timeZone);
  const p = z.parts(now.getTime());
  const last = new Date(Date.UTC(p.y, p.m, 0)).getUTCDate();
  return new Date(z.toUtc(p.y, p.m, last, END_H, END_MI));
}

/** 23:59 local on a `YYYY-MM-DD` day; null when the text is not such a date. */
export function endOfLocalDay(date: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return new Date(makeZone(timeZone).toUtc(y, mo, d, END_H, END_MI));
}

/** `due` + `every` units, keeping the local wall-clock time; a month step clamps to the length of the target month. */
export function addInterval(due: Date, every: number, unit: RepeatUnit, timeZone: string): Date {
  const z = makeZone(timeZone);
  const p = z.parts(due.getTime());
  if (unit === 'month') {
    const total = p.y * 12 + (p.m - 1) + every;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return new Date(z.toUtc(y, m, Math.min(p.d, last), p.h, p.mi));
  }
  const days = unit === 'week' ? every * 7 : every;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return new Date(z.toUtc(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), p.h, p.mi));
}

const key = (p: { y: number; m: number; d: number }): number => p.y * 10_000 + p.m * 100 + p.d;

/** Computes buckets of many items in one zone without rebuilding the formatter. */
export function bucketer(now: Date, timeZone: string): (item: { due: string | null }) => Bucket {
  const z = makeZone(timeZone);
  const nowMs = now.getTime();
  const today = z.parts(nowMs);
  const sunday = new Date(Date.UTC(today.y, today.m - 1, today.d + (7 - today.wd)));
  const weekEnd = key({ y: sunday.getUTCFullYear(), m: sunday.getUTCMonth() + 1, d: sunday.getUTCDate() });
  const nowKey = key(today);
  return (item) => {
    if (!item.due) return 'none';
    const ms = Date.parse(item.due);
    if (Number.isNaN(ms)) return 'none';
    if (ms < nowMs) return 'overdue';
    const p = z.parts(ms);
    const k = key(p);
    if (k === nowKey) return 'today';
    if (k <= weekEnd) return 'week';
    if (p.y === today.y && p.m === today.m) return 'month';
    return 'later';
  };
}

export function bucketOf(item: { due: string | null }, now: Date, timeZone: string): Bucket {
  return bucketer(now, timeZone)(item);
}

export const BUCKET_RANK: Record<Bucket, number> = { overdue: 0, today: 1, week: 2, month: 3, later: 4, none: 5 };
