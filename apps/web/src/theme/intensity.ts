import type { Intensity } from '@dash/contract';

export interface IntensityInputs {
  /** The user's explicit choice from Appearance settings; `null` = automatic. */
  userOverride: Intensity | null;
  reducedMotion: boolean;
  saveData: boolean;
  /** Battery below 20 % and not charging. */
  batteryLow: boolean;
  /** Average frames per second over the last 3 s window, or null when not measured. */
  avgFps: number | null;
  /** Hidden documents do not change the level; the host pauses scenes instead. */
  hidden: boolean;
}

export const FPS_THRESHOLD = 30;
export const FPS_WINDOW_MS = 3000;
export const BATTERY_LOW_LEVEL = 0.2;

const ORDER: Intensity[] = ['static', 'calm', 'full'];
const rank = (i: Intensity): number => ORDER.indexOf(i);
/** One level lower (`static` stays). */
export function lowerIntensity(i: Intensity): Intensity {
  return ORDER[Math.max(0, rank(i) - 1)] ?? 'static';
}
const lowest = (a: Intensity, b: Intensity): Intensity => (rank(a) <= rank(b) ? a : b);

/**
 * Pure decision. A user override always wins. Otherwise reduced motion or data saving force `static`,
 * a low battery gives `calm`, else `full`; a measured `avgFps` below 30 then drops one level.
 * (The governor keeps the "never climbs back" memory and passes `avgFps: null` here.)
 */
export function decideIntensity(i: IntensityInputs): Intensity {
  if (i.userOverride) return i.userOverride;
  if (i.reducedMotion || i.saveData) return 'static';
  const base: Intensity = i.batteryLow ? 'calm' : 'full';
  return i.avgFps !== null && i.avgFps < FPS_THRESHOLD ? lowerIntensity(base) : base;
}

interface Evented {
  addEventListener?(type: string, fn: () => void): void;
  removeEventListener?(type: string, fn: () => void): void;
}
interface MediaQueryLike extends Evented {
  matches: boolean;
}
export interface BatteryLike extends Evented {
  level: number;
  charging: boolean;
}
export interface GovernorDeps {
  matchMedia: ((query: string) => MediaQueryLike) | undefined;
  /** `navigator.connection` (Network Information API), if present. */
  connection: ({ saveData?: boolean } & Evented) | undefined;
  /** `navigator.getBattery`; absent or rejecting counts as "not low". */
  getBattery: (() => Promise<BatteryLike>) | undefined;
  requestAnimationFrame: (fn: () => void) => number;
  cancelAnimationFrame: (handle: number) => void;
  /** Milliseconds, monotonic enough for 3 s windows. */
  now: () => number;
  document: { readonly hidden: boolean } & Required<Evented>;
  /** The user's override (`null` = automatic); defaults to the one set by `setUserIntensityOverride`. */
  userOverride: () => Intensity | null;
  /** Receives every change of the decided level (`theme.setIntensity`). */
  apply: (i: Intensity) => void;
}

let moduleOverride: Intensity | null = null;
const running = new Set<{ refresh(): void }>();

/** Set the user's intensity preference (`null` = automatic). Used by the Appearance settings (later task). */
export function setUserIntensityOverride(i: Intensity | null): void {
  moduleOverride = i;
  for (const g of running) g.refresh();
}

export function createIntensityGovernor(partial: Partial<GovernorDeps> & Pick<GovernorDeps, 'apply'>) {
  const hasWindow = typeof window !== 'undefined';
  const nav = typeof navigator !== 'undefined' ? (navigator as unknown as { connection?: GovernorDeps['connection']; getBattery?: () => Promise<BatteryLike> }) : undefined;
  const deps: GovernorDeps = {
    matchMedia: hasWindow && typeof window.matchMedia === 'function' ? (q) => window.matchMedia(q) : undefined,
    connection: nav?.connection,
    getBattery: typeof nav?.getBattery === 'function' ? () => nav.getBattery!() : undefined,
    requestAnimationFrame: (fn) => requestAnimationFrame(fn),
    cancelAnimationFrame: (h) => cancelAnimationFrame(h),
    now: () => performance.now(),
    document,
    userOverride: () => moduleOverride,
    ...partial,
  };

  const reducedQuery = deps.matchMedia?.('(prefers-reduced-motion: reduce)');
  let battery: BatteryLike | null = null;
  let started = false;
  /** Cap set by fps drops; lives as long as the governor (= the page session). */
  let fpsCap: Intensity = 'full';
  let current: Intensity | null = null;
  let rafHandle: number | null = null;
  let windowStart: number | null = null;
  let frames = 0;
  const cleanups: Array<() => void> = [];

  const hidden = (): boolean => deps.document.hidden;

  function decide(): Intensity {
    const override = deps.userOverride();
    const base = decideIntensity({
      userOverride: override,
      reducedMotion: reducedQuery?.matches ?? false,
      saveData: deps.connection?.saveData === true,
      batteryLow: battery !== null && battery.level < BATTERY_LOW_LEVEL && !battery.charging,
      avgFps: null,
      hidden: hidden(),
    });
    return override ? base : lowest(base, fpsCap);
  }

  /** Sampling runs only while visible, automatic, and a scene animates (`full`/`calm`). */
  function sampling(): boolean {
    return started && !hidden() && deps.userOverride() === null && current !== null && current !== 'static';
  }

  function syncSampling(): void {
    if (sampling()) {
      if (rafHandle === null) {
        windowStart = null;
        frames = 0;
        rafHandle = deps.requestAnimationFrame(frame);
      }
    } else {
      if (rafHandle !== null) deps.cancelAnimationFrame(rafHandle);
      rafHandle = null;
      windowStart = null;
      frames = 0;
    }
  }

  function frame(): void {
    rafHandle = null;
    const t = deps.now();
    if (windowStart === null) {
      windowStart = t;
      frames = 0;
    } else {
      frames++;
      const elapsed = t - windowStart;
      if (elapsed >= FPS_WINDOW_MS) {
        const fps = (frames * 1000) / elapsed;
        windowStart = null;
        frames = 0;
        if (fps < FPS_THRESHOLD) {
          fpsCap = lowerIntensity(current ?? 'full');
          refresh(); // starts a fresh window when still sampling
          return;
        }
      }
    }
    if (sampling()) rafHandle = deps.requestAnimationFrame(frame);
  }

  function refresh(): void {
    if (!started) return;
    const next = decide();
    if (next !== current) {
      current = next;
      deps.apply(next);
    }
    syncSampling();
  }

  function listen(target: Evented | undefined, type: string): void {
    if (!target?.addEventListener) return;
    target.addEventListener(type, refresh);
    cleanups.push(() => target.removeEventListener?.(type, refresh));
  }

  function start(): void {
    if (started) return;
    started = true;
    running.add(api);
    listen(reducedQuery, 'change');
    listen(deps.connection, 'change');
    listen(deps.document, 'visibilitychange');
    refresh();
    deps.getBattery?.().then(
      (b) => {
        if (!started) return;
        battery = b;
        listen(b, 'levelchange');
        listen(b, 'chargingchange');
        refresh();
      },
      () => {
        /* no battery information: treated as not low */
      },
    );
  }

  function stop(): void {
    if (!started) return;
    if (rafHandle !== null) deps.cancelAnimationFrame(rafHandle);
    rafHandle = null;
    started = false;
    running.delete(api);
    for (const c of cleanups.splice(0)) c();
    current = null;
    windowStart = null;
    frames = 0;
  }

  const api = {
    start,
    stop,
    refresh,
    /** Same as the module-level function, for callers holding a governor. */
    setUserIntensityOverride,
    get intensity(): Intensity | null {
      return current;
    },
  };
  return api;
}
export type IntensityGovernor = ReturnType<typeof createIntensityGovernor>;
