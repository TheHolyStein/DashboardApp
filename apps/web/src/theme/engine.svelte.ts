/* eslint-disable svelte/prefer-svelte-reactivity -- Map/Date here are internal, non-reactive bookkeeping (caches, injected clock values). */
import type {
  ChartPalette,
  ClockFaceProps,
  Intensity,
  Mode,
  ModuleId,
  ThemeId,
  ThemeManifest,
  TileProps,
  TileSize,
  Translate,
} from '@dash/contract';
import { validateTheme } from '@dash/contract';
import type { Component } from 'svelte';
import { themes as generatedThemes } from '../generated/themes.js';
import { interpolate, lookupLocale, setStringOverlay } from '../lib/i18n.js';
import { session } from '../lib/session.svelte.js';
import { stream } from '../lib/stream.svelte.js';
import { loadThemeStylesheet, type StylesheetHandle, type StylesheetLoader } from './css-loader.js';
import { msToNextBoundary, resolveMode, type ModePolicy } from './mode.js';

export type ThemeRegistry = Record<
  ThemeId,
  { load: () => Promise<{ default: ThemeManifest }>; meta?: { id: string; name: string } }
>;
type TileComponent = Component<TileProps<any, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any -- overrides are generic over arbitrary data
interface MediaQueryLike {
  matches: boolean;
  addEventListener(type: 'change', fn: (e: { matches: boolean }) => void): void;
}

export interface ThemeEngineDeps {
  registry: ThemeRegistry;
  document: Pick<Document, 'documentElement' | 'head' | 'querySelector' | 'createElement'>;
  matchMedia?: ((query: string) => MediaQueryLike) | undefined;
  now: () => Date;
  loadStylesheet: StylesheetLoader;
  notify: (message: string) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  /** Latest `time.sun` data from the core snapshot, or null. */
  sun: () => { isDay: boolean } | null;
  timeZone: () => string;
  locale: () => string;
  /** Strings of the app locale (below theme strings). */
  localeString: (key: string) => string | undefined;
  /** Resolved value of a CSS custom property on the root element. */
  readToken: (name: string) => string;
  /** One-time failure reports. */
  logError: (...args: unknown[]) => void;
}

const DEFAULT_ID = 'default';

/** Stand-in manifest used before any theme has loaded (or when even `default` cannot). */
function placeholderTheme(): ThemeManifest {
  const palette: ChartPalette = { series: [], grid: '#888888', axis: '#888888', fill: 0.15, lineWidth: 2, glow: false };
  return {
    id: '',
    name: '',
    version: '0.0.0',
    description: '',
    css: [],
    backgrounds: [],
    clockFaces: [],
    icons: {},
    strings: {},
    chart: { day: palette, night: palette },
    pane: { durationMs: 0, in: '', out: '' },
  };
}

export function createThemeEngine(deps: ThemeEngineDeps) {
  let current = $state.raw<ThemeManifest>(placeholderTheme());
  let fallbackTheme = $state.raw<ThemeManifest | null>(null);
  let policy = $state<ModePolicy>('system');
  const mq = deps.matchMedia?.('(prefers-color-scheme: dark)');
  let systemDark = $state(mq?.matches ?? false);
  let tick = $state(0);
  let intensity = $state<Intensity>('full');

  const doc = deps.document;
  const mode = $derived<Mode>(
    resolveMode(policy, {
      systemDark,
      sun: deps.sun(),
      now: (void tick, deps.now()),
      timeZone: deps.timeZone(),
    }),
  );

  // ---- translate: theme strings, then app locale strings, then the fallback ----
  const t: Translate = (key, fallback, vars) => {
    const own = current.strings[deps.locale()];
    const text = (own && Object.hasOwn(own, key) ? own[key] : undefined) ?? deps.localeString(key) ?? fallback;
    return interpolate(text, vars);
  };

  // ---- document chrome ----
  function syncThemeColor(): void {
    const color = deps.readToken('--db-bg').trim();
    if (!color) return;
    let meta = doc.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = doc.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      doc.head.append(meta);
    }
    meta.setAttribute('content', color);
  }

  // ---- mode: system preference ----
  mq?.addEventListener('change', (e) => {
    systemDark = e.matches;
  });

  // ---- mode: DOM attribute and the boundary timer (no polling) ----
  const stopEffects = $effect.root(() => {
    $effect(() => {
      doc.documentElement.setAttribute('data-mode', mode);
      syncThemeColor();
    });
    $effect(() => {
      if (policy !== 'sun' || deps.sun()) return;
      void tick;
      const handle = deps.setTimeout(() => {
        tick++;
      }, msToNextBoundary(deps.now(), deps.timeZone()));
      return () => deps.clearTimeout(handle);
    });
  });

  // ---- theme loading ----
  let applied: StylesheetHandle[] = [];
  let seq = 0;
  let pendingId: ThemeId | null = null;
  let pendingPromise: Promise<void> = Promise.resolve();
  let defaultReported = false;
  let defaultManifest: Promise<ThemeManifest | null> | null = null;

  async function loadManifest(id: ThemeId): Promise<ThemeManifest> {
    const entry = deps.registry[id];
    if (!entry) throw new Error(`unknown theme "${id}"`);
    const manifest = (await entry.load()).default;
    const problems = validateTheme(manifest);
    if (problems.length > 0) throw new Error(`invalid theme "${id}": ${problems.join('; ')}`);
    return manifest;
  }

  /** The default theme's manifest (icons, clock faces); loaded once, failure tolerated. */
  function ensureDefault(): Promise<ThemeManifest | null> {
    defaultManifest ??= loadManifest(DEFAULT_ID).then(
      (m) => {
        fallbackTheme = m;
        return m;
      },
      () => null,
    );
    return defaultManifest;
  }

  /** Manifest plus its loaded stylesheets in order; throws with nothing left in the DOM. */
  async function loadComplete(id: ThemeId): Promise<{ manifest: ThemeManifest; handles: StylesheetHandle[] }> {
    const manifest = await loadManifest(id);
    const handles: StylesheetHandle[] = [];
    try {
      for (const path of manifest.css) handles.push(await deps.loadStylesheet(id, path));
    } catch (e) {
      for (const h of handles) h.remove();
      throw e;
    }
    return { manifest, handles };
  }

  function activate(loaded: { manifest: ThemeManifest; handles: StylesheetHandle[] }): void {
    const old = applied;
    applied = loaded.handles;
    current = loaded.manifest;
    doc.documentElement.setAttribute('data-theme', loaded.manifest.id);
    for (const h of old) h.remove();
    syncThemeColor();
  }

  function reportDefaultFailure(e: unknown): void {
    if (defaultReported) return;
    defaultReported = true;
    deps.logError('[theme] default theme failed to load; running without a theme', e);
    deps.notify(t('theme.defaultFailed', 'The default theme could not be loaded. The dashboard runs unstyled.'));
  }

  async function run(id: ThemeId, mySeq: number): Promise<void> {
    void ensureDefault();
    let result: Awaited<ReturnType<typeof loadComplete>> | null = null;
    try {
      result = await loadComplete(id);
    } catch (e) {
      if (mySeq !== seq) return;
      deps.logError(`[theme] "${id}" failed to load`, e);
      if (id === DEFAULT_ID) {
        reportDefaultFailure(e);
      } else {
        deps.notify(t('theme.loadFailed', 'Theme "{id}" could not be loaded. Using the default theme.', { id }));
        try {
          result = await loadComplete(DEFAULT_ID);
        } catch (e2) {
          if (mySeq === seq) reportDefaultFailure(e2);
        }
      }
    }
    if (!result) return;
    if (mySeq !== seq) {
      for (const h of result.handles) h.remove();
      return;
    }
    activate(result);
  }

  function set(id: ThemeId): Promise<void> {
    if (pendingId === id) return pendingPromise;
    if (pendingId === null && current.id === id) return Promise.resolve();
    const mySeq = ++seq;
    pendingId = id;
    const p = run(id, mySeq).finally(() => {
      if (mySeq === seq) pendingId = null;
    });
    pendingPromise = p;
    return p;
  }

  // ---- tile overrides ----
  type TileEntry = Promise<{ component: TileComponent; minSize?: TileSize } | null>;
  const tileCache = new WeakMap<ThemeManifest, Map<ModuleId, TileEntry>>();
  async function tileFor(moduleId: ModuleId, size?: TileSize): Promise<TileComponent | null> {
    const manifest = current;
    const loader = manifest.tiles?.[moduleId];
    if (!loader) return null;
    let perTheme = tileCache.get(manifest);
    if (!perTheme) tileCache.set(manifest, (perTheme = new Map<ModuleId, TileEntry>()));
    let entry = perTheme.get(moduleId);
    if (!entry) {
      entry = loader().then(
        (mod) => {
          const minSize = (mod as { minSize?: TileSize }).minSize;
          return { component: mod.default, ...(minSize ? { minSize } : {}) };
        },
        (e: unknown) => {
          deps.logError(`[theme] tile override "${moduleId}" of "${manifest.id}" failed to load`, e);
          return null;
        },
      );
      perTheme.set(moduleId, entry);
    }
    const loaded = await entry;
    if (!loaded) return null;
    if (size && loaded.minSize && (size.w < loaded.minSize.w || size.h < loaded.minSize.h)) return null;
    return loaded.component;
  }

  async function clockFace(id?: string): Promise<Component<ClockFaceProps>> {
    const own = current.clockFaces;
    const face = (id ? own.find((f) => f.id === id) : undefined) ?? own[0] ?? (await ensureDefault())?.clockFaces[0];
    if (!face) throw new Error('no clock face available');
    return (await face.component()).default;
  }

  function icon(name: string): string {
    return current.icons[name] ?? fallbackTheme?.icons[name] ?? '';
  }

  function chart(): ChartPalette {
    return current.chart[mode];
  }

  void ensureDefault();

  return {
    get current(): ThemeManifest {
      return current;
    },
    get id(): ThemeId {
      return current.id;
    },
    get mode(): Mode {
      return mode;
    },
    get intensity(): Intensity {
      return intensity;
    },
    get policy(): ModePolicy {
      return policy;
    },
    set,
    setPolicy(p: ModePolicy): void {
      policy = p;
    },
    /** Decided by the governor (task D2). */
    setIntensity(i: Intensity): void {
      intensity = i;
    },
    tileFor,
    clockFace,
    icon,
    chart,
    t,
    dispose(): void {
      stopEffects();
    },
  };
}
export type ThemeEngine = ReturnType<typeof createThemeEngine>;

let notifier: ((message: string) => void) | null = null;
/** Where theme notices (e.g. "theme failed, using default") are shown; set by the shell. Always logged too. */
export function setThemeNotifier(fn: ((message: string) => void) | null): void {
  notifier = fn;
}

const hasDom = typeof document !== 'undefined';

export const theme = createThemeEngine({
  registry: generatedThemes,
  document: hasDom ? document : (undefined as never),
  matchMedia: hasDom && typeof window.matchMedia === 'function' ? (q) => window.matchMedia(q) : undefined,
  now: () => new Date(),
  loadStylesheet: loadThemeStylesheet,
  notify: (message) => {
    console.warn(message);
    notifier?.(message);
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  sun: () => {
    const data = stream.snapshots['core:sun']?.data as { isDay?: unknown } | undefined;
    return data && typeof data.isDay === 'boolean' ? { isDay: data.isDay } : null;
  },
  timeZone: () => session.me?.prefs.timeZone ?? 'UTC',
  locale: () => session.me?.prefs.locale ?? 'en',
  localeString: lookupLocale,
  readToken: (name) => (hasDom ? getComputedStyle(document.documentElement).getPropertyValue(name) : ''),
  logError: (...a) => console.error(...a),
});

// Theme strings also reach module code that uses the global `t` from lib/i18n.
setStringOverlay((key) => {
  const own = theme.current.strings[session.me?.prefs.locale ?? 'en'];
  return own && Object.hasOwn(own, key) ? own[key] : undefined;
});
