// Formatting helpers shared by the Clock tile and detail. Pure; no module state beyond the formatter cache.

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * A cached `Intl.DateTimeFormat` per (locale, options incl. zone). An unknown stored zone (or locale) makes the
 * constructor throw a `RangeError`: fall back to UTC (and the default locale) so a render never crashes. The
 * fallback is cached under the same key, so the warning appears once per failing (locale, zone) pair.
 */
export function dateFormatter(options: Intl.DateTimeFormatOptions, locale: string): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, options);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      console.warn(`clock: cannot format with locale "${locale}" / zone "${options.timeZone ?? ''}", using UTC`);
      try {
        f = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
      } catch {
        f = new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' });
      }
    }
    formatters.set(key, f);
  }
  return f;
}

/** Wall-clock text for `timeZone`: `HH:mm` (with seconds when asked), in the user's locale. */
export function formatTime(now: Date, o: { locale: string; timeZone: string; hour12: boolean; seconds: boolean }): string {
  return dateFormatter({
    hour: '2-digit',
    minute: '2-digit',
    second: o.seconds ? '2-digit' : undefined,
    hourCycle: o.hour12 ? 'h12' : 'h23',
    timeZone: o.timeZone,
  }, o.locale).format(now);
}

/** Short date for `timeZone`, e.g. "Thu, 1 Jan". */
export function formatDate(now: Date, o: { locale: string; timeZone: string }): string {
  return dateFormatter({ weekday: 'short', day: 'numeric', month: 'short', timeZone: o.timeZone }, o.locale).format(now);
}

/** `m:ss`, or `h:mm:ss` from one hour up. Negative input is clamped to 0. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** `m:ss.cc` (centiseconds), for the stopwatch. */
export function formatStopwatch(ms: number): string {
  const cs = Math.floor(Math.max(0, ms) / 10);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${m}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}
