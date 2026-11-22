import { describe, expect, it } from 'vitest';
import { formatRelative, identityT } from '../src/index.js';

const NOW = new Date('2026-11-14T12:00:00Z');
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);

describe('formatRelative', () => {
  it.each([
    [0, 'just now'],
    [44, 'just now'],
    [45, '1 min ago'],
    [119, '1 min ago'],
    [120, '2 min ago'],
    [59 * 60, '59 min ago'],
    [3600, '1 h ago'],
    [3 * 3600 + 5, '3 h ago'],
    [23 * 3600 + 3599, '23 h ago'],
    [24 * 3600, 'yesterday'],
    [47 * 3600, 'yesterday'],
    [48 * 3600, '2 days ago'],
    [7 * 86400 + 3600, '7 days ago'],
  ])('%i s ago -> %s', (s, expected) => {
    expect(formatRelative(ago(s), NOW, identityT)).toBe(expected);
  });

  it('uses a short date beyond 7 days', () => {
    const d = ago(8 * 86400);
    expect(formatRelative(d, NOW, identityT)).toBe(new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d));
  });

  it('accepts ISO strings and clamps future dates to just now', () => {
    expect(formatRelative('2026-11-14T11:00:00Z', NOW, identityT)).toBe('1 h ago');
    expect(formatRelative(new Date(NOW.getTime() + 3_600_000), NOW, identityT)).toBe('just now');
  });

  it('returns an empty string for an invalid date', () => {
    expect(formatRelative('garbage', NOW, identityT)).toBe('');
  });

  it('uses separate keys for singular and plural', () => {
    const keys: string[] = [];
    const t = (key: string, fb: string) => (keys.push(key), fb);
    formatRelative(ago(60), NOW, t);
    formatRelative(ago(180), NOW, t);
    formatRelative(ago(3600), NOW, t);
    formatRelative(ago(7200), NOW, t);
    expect(keys).toEqual(['time.minuteAgo', 'time.minutesAgo', 'time.hourAgo', 'time.hoursAgo']);
  });
});
