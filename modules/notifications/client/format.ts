// Formatting helpers for the Notifications tile and detail. Pure; only a formatter cache as module state.
import type { Translate } from '@dash/contract';

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A cached formatter; an unknown locale or zone falls back to UTC and the default locale instead of throwing. */
function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, options);
    } catch {
      f = new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' });
    }
    formatters.set(key, f);
  }
  return f;
}

/** The calendar day (`YYYY-MM-DD`) of an instant in the user's zone: the key notifications are grouped by. */
export function dayKey(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const parts = formatter('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).formatToParts(d);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** "Thursday, November 12" for a `dayKey`. A day key has no zone: it is formatted as is. */
export function formatDay(key: string, locale: string): string {
  const d = new Date(`${key}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return key;
  return formatter(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d);
}

export function formatClock(iso: string, locale: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatter(locale, { hour: '2-digit', minute: '2-digit', timeZone }).format(d);
}

export function formatDateTime(iso: string, locale: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatter(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(d);
}

/** Day groups in the order given (newest first): consecutive items of one local day share a group. */
export function groupByDay<T extends { createdAt: string }>(items: T[], timeZone: string): Array<{ key: string; items: T[] }> {
  const groups: Array<{ key: string; items: T[] }> = [];
  for (const item of items) {
    const key = dayKey(item.createdAt, timeZone);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, items: [item] });
  }
  return groups;
}

const LEVEL_NAMES = { info: 'Info', warn: 'Warning', critical: 'Critical' } as const;

/** The word for a level, so colour is never the only signal. An unknown level is shown as sent. */
export function levelName(level: string, t: Translate): string {
  return level === 'info' || level === 'warn' || level === 'critical' ? t(`m.notifications.level.${level}`, LEVEL_NAMES[level]) : level;
}

/** The CSS class for a level; unknown levels get none. */
export const levelClass = (level: string): string => (level === 'warn' || level === 'critical' ? level : 'info');
