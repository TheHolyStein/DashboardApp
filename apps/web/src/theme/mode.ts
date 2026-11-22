import type { Mode } from '@dash/contract';

export type ModePolicy = 'day' | 'night' | 'system' | 'sun';
export interface ModeContext {
  systemDark: boolean;
  sun: { isDay: boolean } | null;
  now: Date;
  /** IANA zone for the 07:00-19:00 fallback; defaults to the runtime's local zone. */
  timeZone?: string;
}

export const DAY_START_HOUR = 7;
export const NIGHT_START_HOUR = 19;
const DAY_SECONDS = 86_400;

/** Seconds since local midnight of `now` in `timeZone` (runtime zone when omitted or invalid). */
export function secondsOfDay(now: Date, timeZone?: string): number {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hourCycle: 'h23',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      }).formatToParts(now);
      const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
      return (get('hour') % 24) * 3600 + get('minute') * 60 + get('second');
    } catch {
      /* invalid zone: fall through to the runtime zone */
    }
  }
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
}

export function fallbackIsDay(now: Date, timeZone?: string): boolean {
  const s = secondsOfDay(now, timeZone);
  return s >= DAY_START_HOUR * 3600 && s < NIGHT_START_HOUR * 3600;
}

/** Milliseconds until the next 07:00 or 19:00 in `timeZone` (always > 0). */
export function msToNextBoundary(now: Date, timeZone?: string): number {
  const s = secondsOfDay(now, timeZone);
  let best = DAY_SECONDS;
  for (const h of [DAY_START_HOUR, NIGHT_START_HOUR]) {
    let d = h * 3600 - s;
    if (d <= 0) d += DAY_SECONDS;
    best = Math.min(best, d);
  }
  return best * 1000 - now.getMilliseconds();
}

export function resolveMode(policy: ModePolicy, ctx: ModeContext): Mode {
  switch (policy) {
    case 'day':
      return 'day';
    case 'night':
      return 'night';
    case 'system':
      return ctx.systemDark ? 'night' : 'day';
    case 'sun':
      return (ctx.sun ? ctx.sun.isDay : fallbackIsDay(ctx.now, ctx.timeZone)) ? 'day' : 'night';
  }
}
