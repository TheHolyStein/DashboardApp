/* eslint-disable svelte/prefer-svelte-reactivity -- plain bookkeeping and injected clock values in a test harness. */
import type { ChartPalette, ThemeManifest } from '@dash/contract';
import type { Component } from 'svelte';
import { flushSync } from 'svelte';
import { createThemeEngine, type ThemeEngineDeps, type ThemeRegistry } from '../../../src/theme/engine.svelte.js';
import type { StylesheetHandle } from '../../../src/theme/css-loader.js';

const dummy = (name: string) => (() => name) as unknown as Component<never>;

function palette(base: string): ChartPalette {
  return { series: [1, 2, 3, 4, 5, 6].map((n) => `${base}${n}`), grid: '#111', axis: '#222', fill: 0.2, lineWidth: 2, glow: false };
}

export interface FixtureOpts {
  css?: string[];
  icons?: Record<string, string>;
  strings?: Record<string, Record<string, string>>;
  faces?: string[];
  tiles?: ThemeManifest['tiles'];
}

/** A valid manifest; every field is overridable. */
export function makeTheme(id: string, o: FixtureOpts = {}): ThemeManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: `${id} fixture`,
    css: o.css ?? ['tokens.css', 'extra.css'],
    backgrounds: [{ id: 'plain', name: 'Plain', component: () => Promise.resolve({ default: dummy('bg') }) as never, staticImage: 'bg.webp' }],
    clockFaces: (o.faces ?? ['digital']).map((f) => ({
      id: f,
      name: f,
      component: () => Promise.resolve({ default: dummy(`${id}:${f}`) }) as never,
    })),
    icons: o.icons ?? {},
    strings: o.strings ?? {},
    chart: { day: palette(`${id}-d`), night: palette(`${id}-n`) },
    pane: { durationMs: 200, in: 'in', out: 'out' },
    ...(o.tiles ? { tiles: o.tiles } : {}),
  };
}

/** A manifest that fails `validateTheme` (no backgrounds, css[0] is not tokens.css). */
export function brokenTheme(id: string): ThemeManifest {
  return { ...makeTheme(id), css: ['oops.css'], backgrounds: [] };
}

export interface Harness {
  engine: ReturnType<typeof createThemeEngine>;
  /** Stylesheets currently "in the document": `theme/path`. */
  sheets: string[];
  /** Every load attempt in call order: `theme/path`. */
  loadLog: string[];
  notices: string[];
  errors: unknown[][];
  timers: Array<{ ms: number; fn: () => void; cancelled: boolean }>;
  /** Make the next loads of `theme/path` fail. */
  failCss(...keys: string[]): void;
  /** Hold loads of the theme until released. */
  holdCss(themeId: string): () => void;
  setNow(iso: string): void;
  setDark(dark: boolean): void;
  setSun(sun: { isDay: boolean } | null): void;
  setTimeZone(tz: string): void;
  setLocale(l: string): void;
  tokens: Record<string, string>;
  flush(): void;
}

export interface HarnessOpts {
  themes: Record<string, () => Promise<{ default: ThemeManifest }>>;
  now?: string;
  dark?: boolean;
  timeZone?: string;
  locale?: string;
  localeStrings?: Record<string, string>;
}

/** Build an engine against fake registry, stylesheet loader, matchMedia, clock and timers (jsdom `document`). */
export function makeHarness(o: HarnessOpts): Harness {
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-mode');
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());

  let now = new Date(o.now ?? '2026-11-14T12:00:00Z');
  const box = $state<{ sun: { isDay: boolean } | null; tz: string; locale: string }>({ sun: null, tz: o.timeZone ?? 'UTC', locale: o.locale ?? 'en' });
  const failing = new Set<string>();
  const holds = new Map<string, Promise<void>>();
  const sheets: string[] = [];
  const loadLog: string[] = [];
  const timers: Harness['timers'] = [];
  const listeners: Array<(e: { matches: boolean }) => void> = [];
  const mq = {
    matches: o.dark ?? false,
    addEventListener: (_: 'change', fn: (e: { matches: boolean }) => void) => void listeners.push(fn),
    removeEventListener: (_: 'change', fn: (e: { matches: boolean }) => void) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const tokens: Record<string, string> = {};

  const registry: ThemeRegistry = Object.fromEntries(Object.entries(o.themes).map(([id, load]) => [id, { load }]));
  const deps: ThemeEngineDeps = {
    registry,
    document,
    matchMedia: () => mq,
    now: () => now,
    loadStylesheet: async (themeId, path) => {
      const key = `${themeId}/${path}`;
      loadLog.push(key);
      await holds.get(themeId);
      if (failing.has(key)) throw new Error(`css failed: ${key}`);
      sheets.push(key);
      const handle: StylesheetHandle = {
        remove: () => {
          const i = sheets.indexOf(key);
          if (i >= 0) sheets.splice(i, 1);
        },
      };
      return handle;
    },
    notify: (m) => void notices.push(m),
    setTimeout: (fn, ms) => {
      const timer = { ms, fn, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (h) => {
      (h as { cancelled: boolean }).cancelled = true;
    },
    sun: () => box.sun,
    timeZone: () => box.tz,
    locale: () => box.locale,
    localeString: (k) => o.localeStrings?.[k],
    readToken: (name) => {
      const id = document.documentElement.getAttribute('data-theme') ?? '';
      const m = document.documentElement.getAttribute('data-mode') ?? '';
      return tokens[`${id}/${m}/${name}`] ?? '';
    },
    logError: (...a) => void errors.push(a),
  };
  const notices: string[] = [];
  const errors: unknown[][] = [];
  const engine = createThemeEngine(deps);
  flushSync();

  return {
    engine,
    sheets,
    loadLog,
    notices,
    errors,
    timers,
    tokens,
    failCss: (...keys) => keys.forEach((k) => failing.add(k)),
    holdCss: (themeId) => {
      let release!: () => void;
      holds.set(themeId, new Promise<void>((r) => (release = r)));
      return () => {
        holds.delete(themeId);
        release();
      };
    },
    setNow: (iso) => void (now = new Date(iso)),
    setDark: (dark) => {
      mq.matches = dark;
      listeners.forEach((fn) => fn({ matches: dark }));
      flushSync();
    },
    setSun: (s) => void (box.sun = s),
    setTimeZone: (z) => void (box.tz = z),
    setLocale: (l) => void (box.locale = l),
    flush: () => flushSync(),
  };
}
