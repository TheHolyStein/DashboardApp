function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** `YYYY-MM-DD` of the local calendar day of an instant (the value of an `<input type="date">`). */
export function localDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: safeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(iso),
  );
}

/** "Thu, 19 Nov", plus the time of day unless it is the end of the day (23:59 stands for "that day"). */
export function formatDue(iso: string, opts: { locale: string; timeZone: string }): string {
  const timeZone = safeZone(opts.timeZone);
  const at = new Date(iso);
  const day = new Intl.DateTimeFormat(opts.locale, { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(at);
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  if (clock === '23:59') return day;
  const time = new Intl.DateTimeFormat(opts.locale, { timeZone, hour: 'numeric', minute: '2-digit' }).format(at);
  return `${day} ${time}`;
}
