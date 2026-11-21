// Formatting helpers shared by the Briefing tile and detail. Pure; only a formatter cache as module state.
import type { Translate } from '@dash/contract';
import type { WeatherHint } from '../manifest.js';

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

/** "Thursday, 12 November" for a local date `YYYY-MM-DD`. The date has no zone: it is formatted as is. */
export function formatDay(date: string, locale: string): string {
  const d = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return date;
  return formatter(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d);
}

/** Wall-clock time of an instant in the user's zone. */
export function formatClock(iso: string, locale: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return formatter(locale, { hour: '2-digit', minute: '2-digit', timeZone }).format(d);
}

/** "in 25 min", "in 2 h", "in 3 days", "now". Minutes round up so the last minute never reads "now". */
export function countdown(startIso: string, now: Date, t: Translate): string {
  const minutes = Math.ceil((Date.parse(startIso) - now.getTime()) / 60_000);
  if (Number.isNaN(minutes) || minutes <= 0) return t('m.briefing.now', 'now');
  if (minutes < 60) return minutes === 1 ? t('m.briefing.inMin.one', 'in 1 min') : t('m.briefing.inMin.other', 'in {n} min', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? t('m.briefing.inHour.one', 'in 1 h') : t('m.briefing.inHour.other', 'in {n} h', { n: hours });
  const days = Math.floor(hours / 24);
  return days === 1 ? t('m.briefing.inDay.one', 'in 1 day') : t('m.briefing.inDay.other', 'in {n} days', { n: days });
}

/** The one-line weather hint, in words. Times and temperatures in it are formatted for the user's locale and zone. */
export function hintText(hint: WeatherHint, t: Translate, locale: string, timeZone: string): string {
  const num = (n: number): string => {
    try {
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n);
    } catch {
      return String(Math.round(n));
    }
  };
  switch (hint.key) {
    case 'storm':
      return t('m.briefing.hint.storm', 'Storm expected today');
    case 'rainAt':
      return t('m.briefing.hint.rainAt', 'Rain expected around {time}', { time: formatClock(String(hint.vars['at'] ?? ''), locale, timeZone) });
    case 'frost':
      return t('m.briefing.hint.frost', 'Frost: {temp} °C', { temp: num(Number(hint.vars['tempC'] ?? 0)) });
    case 'hot':
      return t('m.briefing.hint.hot', 'Hot day: {temp} °C', { temp: num(Number(hint.vars['tempC'] ?? 0)) });
    case 'pollenHigh':
      return t('m.briefing.hint.pollenHigh', 'High pollen count');
    case 'dry':
      return t('m.briefing.hint.dry', 'Dry weather ahead');
  }
}

const LISTS = ['week', 'month', 'deadline', 'shopping', 'chores'] as const;
const LIST_NAMES: Record<(typeof LISTS)[number], string> = {
  week: 'This week',
  month: 'This month',
  deadline: 'Deadlines',
  shopping: 'Shopping',
  chores: 'Chores',
};

/** Display name of a todo list id; an id this module does not know is shown as sent. */
export function listName(list: string, t: Translate): string {
  const known = (LISTS as readonly string[]).includes(list) ? (list as (typeof LISTS)[number]) : null;
  return known ? t(`m.briefing.list.${known}`, LIST_NAMES[known]) : list;
}
