import { describe, expect, it } from 'vitest';
import { fallbackIsDay, msToNextBoundary, resolveMode } from '../../src/theme/mode.js';

const at = (iso: string) => new Date(iso);

describe('resolveMode', () => {
  it('resolveMode for each policy', () => {
    const base = { systemDark: false, sun: null, now: at('2026-11-14T12:00:00Z'), timeZone: 'UTC' };
    expect(resolveMode('day', { ...base, systemDark: true })).toBe('day');
    expect(resolveMode('night', base)).toBe('night');
    expect(resolveMode('system', base)).toBe('day');
    expect(resolveMode('system', { ...base, systemDark: true })).toBe('night');
    expect(resolveMode('sun', { ...base, sun: { isDay: false } })).toBe('night');
    expect(resolveMode('sun', { ...base, sun: { isDay: true }, now: at('2026-11-14T02:00:00Z') })).toBe('day');
  });

  it('sun policy without data uses 07–19 fallback', () => {
    const ctx = (iso: string) => ({ systemDark: false, sun: null, now: at(iso), timeZone: 'UTC' });
    expect(resolveMode('sun', ctx('2026-11-14T06:59:59Z'))).toBe('night');
    expect(resolveMode('sun', ctx('2026-11-14T07:00:00Z'))).toBe('day');
    expect(resolveMode('sun', ctx('2026-11-14T18:59:59Z'))).toBe('day');
    expect(resolveMode('sun', ctx('2026-11-14T19:00:00Z'))).toBe('night');
  });

  it('fallback uses the given time zone, not the runtime zone', () => {
    const now = at('2026-11-14T06:30:00Z'); // 07:30 in Berlin (CET, UTC+1)
    expect(fallbackIsDay(now, 'UTC')).toBe(false);
    expect(fallbackIsDay(now, 'Europe/Berlin')).toBe(true);
    expect(fallbackIsDay(now, 'Not/AZone')).toBe(fallbackIsDay(now)); // invalid zone: runtime zone
  });

  it('msToNextBoundary targets 07:00 or 19:00 in the zone', () => {
    expect(msToNextBoundary(at('2026-11-14T06:30:00Z'), 'UTC')).toBe(30 * 60_000);
    expect(msToNextBoundary(at('2026-11-14T06:30:00Z'), 'Europe/Berlin')).toBe((11 * 60 + 30) * 60_000);
    expect(msToNextBoundary(at('2026-11-14T19:00:00Z'), 'UTC')).toBe(12 * 3600_000);
    expect(msToNextBoundary(at('2026-11-14T20:00:00.500Z'), 'UTC')).toBe(11 * 3600_000 - 500);
  });
});
