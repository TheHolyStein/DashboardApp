import type { ThemeManifest } from '@dash/contract';
import { describe, expect, it } from 'vitest';
import { brokenTheme, makeHarness, makeTheme, type Harness } from './fixtures/harness.svelte.js';

const root = document.documentElement;
const ok = (m: ThemeManifest) => () => Promise.resolve({ default: m });
const fail = () => Promise.reject(new Error('no such file'));

const Big = () => 'big';
const tiles = (mod: object) => ({ clock: () => Promise.resolve(mod as { default: never }) });

function plain(extra: Record<string, () => Promise<{ default: ThemeManifest }>> = {}, def = makeTheme('default')): Harness {
  return makeHarness({ themes: { default: ok(def), alt: ok(makeTheme('alt')), ...extra } });
}

describe('theme.set', () => {
  it('set() swaps data-theme and unloads old css', async () => {
    const h = plain();
    await h.engine.set('default');
    expect(root.getAttribute('data-theme')).toBe('default');
    expect(h.sheets).toEqual(['default/tokens.css', 'default/extra.css']);
    await h.engine.set('alt');
    expect(root.getAttribute('data-theme')).toBe('alt');
    expect(h.sheets).toEqual(['alt/tokens.css', 'alt/extra.css']);
    expect(h.engine.id).toBe('alt');
  });

  it('applies data-theme only after all CSS loaded and keeps the old css until then', async () => {
    const h = plain();
    await h.engine.set('default');
    const release = h.holdCss('alt');
    const p = h.engine.set('alt');
    await Promise.resolve();
    await Promise.resolve();
    expect(root.getAttribute('data-theme')).toBe('default');
    expect(h.sheets).toEqual(['default/tokens.css', 'default/extra.css']);
    release();
    await p;
    expect(root.getAttribute('data-theme')).toBe('alt');
    expect(h.sheets).toEqual(['alt/tokens.css', 'alt/extra.css']);
  });

  it('loads css in order, tokens first', async () => {
    const h = plain();
    await h.engine.set('alt');
    expect(h.loadLog.filter((k) => k.startsWith('alt/'))).toEqual(['alt/tokens.css', 'alt/extra.css']);
  });

  it('two rapid set() calls end on the second theme with only its stylesheets', async () => {
    const h = plain({ third: ok(makeTheme('third')) });
    await h.engine.set('default');
    const p1 = h.engine.set('alt');
    const p2 = h.engine.set('third');
    await Promise.all([p1, p2]);
    expect(root.getAttribute('data-theme')).toBe('third');
    expect(h.engine.id).toBe('third');
    expect(h.sheets).toEqual(['third/tokens.css', 'third/extra.css']);
  });

  it('setting the current theme again is a no-op', async () => {
    const h = plain();
    await h.engine.set('alt');
    const n = h.loadLog.length;
    await h.engine.set('alt');
    expect(h.loadLog.length).toBe(n);
  });

  it('broken theme falls back to default', async () => {
    const h = plain({ bad: ok(brokenTheme('bad')) });
    await h.engine.set('bad');
    expect(h.engine.id).toBe('default');
    expect(root.getAttribute('data-theme')).toBe('default');
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('bad');
  });

  it('a theme whose css fails to load falls back to default and removes partial css', async () => {
    const h = plain({ css: ok(makeTheme('css')) });
    h.failCss('css/extra.css');
    await h.engine.set('css');
    expect(h.engine.id).toBe('default');
    expect(h.sheets).toEqual(['default/tokens.css', 'default/extra.css']);
    expect(h.notices).toHaveLength(1);
  });

  it('an unknown theme falls back to default', async () => {
    const h = plain();
    await h.engine.set('nope');
    expect(h.engine.id).toBe('default');
  });

  it('default failing does not throw, reports once, and the engine keeps running', async () => {
    const h = makeHarness({ themes: { default: fail, bad: fail } });
    await expect(h.engine.set('bad')).resolves.toBeUndefined();
    await expect(h.engine.set('default')).resolves.toBeUndefined();
    expect(h.sheets).toEqual([]);
    expect(h.engine.id).toBe('');
    expect(h.notices.filter((m) => m.includes('runs unstyled'))).toHaveLength(1);
    expect(h.engine.icon('x')).toBe('');
    expect(h.engine.mode).toBe('day');
  });
});

describe('strings and icons', () => {
  it('t prefers theme string over locale string over fallback', async () => {
    const alt = makeTheme('alt', { strings: { en: { greet: 'Theme hi {name}' }, de: { greet: 'Hallo {name}' } } });
    const h = makeHarness({
      themes: { default: ok(makeTheme('default')), alt: ok(alt) },
      localeStrings: { greet: 'Locale hi', only: 'Locale only {x}' },
    });
    await h.engine.set('default');
    expect(h.engine.t('greet', 'Fallback')).toBe('Locale hi');
    expect(h.engine.t('missing', 'Fallback {n}', { n: 3 })).toBe('Fallback 3');
    await h.engine.set('alt');
    expect(h.engine.t('greet', 'Fallback', { name: 'Ann' })).toBe('Theme hi Ann');
    expect(h.engine.t('only', 'Fallback', { x: 1 })).toBe('Locale only 1');
    h.setLocale('de');
    expect(h.engine.t('greet', 'Fallback', { name: 'Ann' })).toBe('Hallo Ann');
  });

  it('icon falls back to default theme', async () => {
    const def = makeTheme('default', { icons: { bell: '<svg d/>', warn: '<svg dw/>' } });
    const h = plain({ alt: ok(makeTheme('alt', { icons: { bell: '<svg a/>' } })) }, def);
    await h.engine.set('alt');
    expect(h.engine.icon('bell')).toBe('<svg a/>');
    expect(h.engine.icon('warn')).toBe('<svg dw/>');
    expect(h.engine.icon('unknown')).toBe('');
  });
});

describe('clockFace and chart', () => {
  it("clockFace('missing') falls back to the first face; no theme face falls back to default's", async () => {
    const alt = makeTheme('alt', { faces: ['round', 'square'] });
    const h = plain({ alt: ok(alt) });
    await h.engine.set('alt');
    expect((await h.engine.clockFace('missing'))({} as never, {} as never)).toBe('alt:round');
    expect((await h.engine.clockFace('square'))({} as never, {} as never)).toBe('alt:square');
    expect((await h.engine.clockFace())({} as never, {} as never)).toBe('alt:round');
  });

  it('chart follows the mode', async () => {
    const h = plain();
    await h.engine.set('alt');
    h.engine.setPolicy('night');
    h.flush();
    expect(h.engine.chart().series[0]).toBe('alt-n1');
    h.engine.setPolicy('day');
    h.flush();
    expect(h.engine.chart().series[0]).toBe('alt-d1');
  });
});

describe('tileFor', () => {
  it('returns null without an override, below minSize, and the component at or above it', async () => {
    const withTile = makeTheme('tiled', { tiles: tiles({ default: Big, minSize: { w: 3, h: 2 } }) });
    const h = plain({ tiled: ok(withTile) });
    await h.engine.set('default');
    expect(await h.engine.tileFor('clock')).toBeNull();
    await h.engine.set('tiled');
    expect(await h.engine.tileFor('weather')).toBeNull();
    expect(await h.engine.tileFor('clock', { w: 2, h: 2 })).toBeNull();
    expect(await h.engine.tileFor('clock', { w: 3, h: 1 })).toBeNull();
    expect(await h.engine.tileFor('clock', { w: 3, h: 2 })).toBe(Big);
    expect(await h.engine.tileFor('clock', { w: 5, h: 4 })).toBe(Big);
    expect(await h.engine.tileFor('clock')).toBe(Big);
  });

  it('caches the lazy import and logs a failure once', async () => {
    let calls = 0;
    const broken = makeTheme('tiled', {
      tiles: {
        clock: () => {
          calls++;
          return Promise.reject(new Error('chunk gone'));
        },
      },
    });
    const h = plain({ tiled: ok(broken) });
    await h.engine.set('tiled');
    expect(await h.engine.tileFor('clock')).toBeNull();
    expect(await h.engine.tileFor('clock')).toBeNull();
    expect(calls).toBe(1);
    expect(h.errors.filter((e) => String(e[0]).includes('tile override'))).toHaveLength(1);
  });
});

describe('mode', () => {
  it('system policy follows a matchMedia change and data-mode follows', () => {
    const h = plain();
    h.engine.setPolicy('system');
    h.flush();
    expect(root.getAttribute('data-mode')).toBe('day');
    h.setDark(true);
    expect(h.engine.mode).toBe('night');
    expect(root.getAttribute('data-mode')).toBe('night');
    h.setDark(false);
    expect(root.getAttribute('data-mode')).toBe('day');
  });

  it('dispose() removes the matchMedia listener', () => {
    const h = plain();
    h.engine.setPolicy('system');
    h.flush();
    h.engine.dispose();
    h.setDark(true);
    expect(h.engine.mode).toBe('day');
  });

  it('explicit day/night ignore the system', () => {
    const h = makeHarness({ themes: {}, dark: true });
    h.engine.setPolicy('day');
    h.flush();
    expect(root.getAttribute('data-mode')).toBe('day');
    h.engine.setPolicy('night');
    h.flush();
    expect(root.getAttribute('data-mode')).toBe('night');
  });

  it('sun policy uses the user time zone for the 07–19 fallback', () => {
    const berlin = makeHarness({ themes: {}, now: '2026-11-14T06:30:00Z', timeZone: 'Europe/Berlin' });
    berlin.engine.setPolicy('sun');
    berlin.flush();
    expect(berlin.engine.mode).toBe('day');
    const utc = makeHarness({ themes: {}, now: '2026-11-14T06:30:00Z', timeZone: 'UTC' });
    utc.engine.setPolicy('sun');
    utc.flush();
    expect(utc.engine.mode).toBe('night');
  });

  it('sun policy re-evaluates at the next boundary with one timer, no polling', () => {
    const h = makeHarness({ themes: {}, now: '2026-11-14T06:30:00Z', timeZone: 'UTC' });
    h.engine.setPolicy('sun');
    h.flush();
    expect(h.engine.mode).toBe('night');
    const live = () => h.timers.filter((t) => !t.cancelled);
    expect(live()).toHaveLength(1);
    expect(live()[0]?.ms).toBe(30 * 60_000);
    h.setNow('2026-11-14T07:00:00Z');
    live()[0]?.fn();
    h.flush();
    expect(h.engine.mode).toBe('day');
    expect(root.getAttribute('data-mode')).toBe('day');
    expect(live()).toHaveLength(1);
    expect(live()[0]?.ms).toBe(12 * 3600_000);
  });

  it('sun data wins over the fallback and stops the timer', () => {
    const h = makeHarness({ themes: {}, now: '2026-11-14T12:00:00Z' });
    h.engine.setPolicy('sun');
    h.flush();
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(1);
    h.setSun({ isDay: false });
    h.flush();
    expect(h.engine.mode).toBe('night');
    expect(h.timers.filter((t) => !t.cancelled)).toHaveLength(0);
  });

  it('theme-color meta follows the --db-bg token after theme and mode changes', async () => {
    const h = plain();
    h.tokens['alt/day/--db-bg'] = '#f4f5f8';
    h.tokens['alt/night/--db-bg'] = '#0b0d12';
    h.engine.setPolicy('day');
    h.flush();
    await h.engine.set('alt');
    const meta = () => document.querySelector('meta[name="theme-color"]')?.getAttribute('content');
    expect(meta()).toBe('#f4f5f8');
    h.engine.setPolicy('night');
    h.flush();
    expect(meta()).toBe('#0b0d12');
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(1);
  });
});

describe('intensity', () => {
  it('defaults to full and follows setIntensity', () => {
    const h = plain();
    expect(h.engine.intensity).toBe('full');
    h.engine.setIntensity('calm');
    expect(h.engine.intensity).toBe('calm');
  });
});
