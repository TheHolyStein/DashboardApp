import type { Translate } from '@dash/contract';

const JUST_NOW_S = 45;
const MIN_S = 60;
const HOUR_S = 3600;
const DAY_S = 86400;
const MAX_DAYS = 7;

/**
 * Human freshness text relative to `now` (elapsed time, not calendar days):
 * < 45 s "just now" (also for future dates), < 1 h "N min ago", < 24 h "N h ago",
 * 1 day "yesterday", 2 to 7 days "N days ago", older a short date. Invalid dates give "".
 */
export function formatRelative(date: Date | string, now: Date, t: Translate): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const ms = now.getTime() - d.getTime();
  if (Number.isNaN(ms)) return '';
  const s = Math.max(0, ms / 1000);
  if (s < JUST_NOW_S) return t('time.justNow', 'just now');
  if (s < HOUR_S) {
    const n = Math.max(1, Math.floor(s / MIN_S));
    return n === 1 ? t('time.minuteAgo', '{n} min ago', { n }) : t('time.minutesAgo', '{n} min ago', { n });
  }
  if (s < DAY_S) {
    const n = Math.floor(s / HOUR_S);
    return n === 1 ? t('time.hourAgo', '{n} h ago', { n }) : t('time.hoursAgo', '{n} h ago', { n });
  }
  const days = Math.floor(s / DAY_S);
  if (days === 1) return t('time.yesterday', 'yesterday');
  if (days <= MAX_DAYS) return t('time.daysAgo', '{n} days ago', { n: days });
  const date2 = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d);
  return t('time.on', '{date}', { date: date2 });
}
