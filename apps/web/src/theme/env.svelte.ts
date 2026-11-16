import { WeatherCondition, type SceneEnv } from '@dash/contract';
import { stream } from '../lib/stream.svelte.js';

type Condition = NonNullable<SceneEnv['weather']>;
export interface SunTimes {
  sunrise: string;
  sunset: string;
}
/** What the shell's lookup returns: the `data` of the user's weather and moon snapshots (or undefined). */
export interface BoundSnapshots {
  weather?: unknown;
  moon?: unknown;
}
export interface SceneEnvDeps {
  now: () => Date;
  /** Sunrise/sunset of `core:sun` (ISO strings) or null. Reactive when it reads reactive state. */
  sun: () => SunTimes | null;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  document: { readonly hidden: boolean; addEventListener(t: 'visibilitychange', fn: () => void): void; removeEventListener(t: 'visibilitychange', fn: () => void): void } | undefined;
}

const DAY_MS = 86_400_000;
const TICK_MS = 60_000;
/** Assumed noon altitude and midnight depth of the approximation; the result is clamped to -18..90. */
const NOON_PEAK_DEG = 60;
const MIDNIGHT_DEPTH_DEG = 30;

/**
 * Approximate sun altitude without ephemeris maths: by day a sine arc from sunrise (0 deg) through solar
 * noon (the midpoint, NOON_PEAK_DEG) to sunset (0 deg); by night the mirrored arc down to MIDNIGHT_DEPTH_DEG
 * below the horizon, clamped to -18 (astronomical twilight). The snapshot's times may belong to another day,
 * so they are shifted by whole days until `now` lies in the day starting at sunrise. Null for unusable data.
 */
export function approximateSunAltitude(now: Date, sun: SunTimes | null): number | null {
  if (!sun) return null;
  let rise = Date.parse(sun.sunrise);
  let set = Date.parse(sun.sunset);
  if (!Number.isFinite(rise) || !Number.isFinite(set)) return null;
  // The two times may come from different calendar days; take the set that follows the rise.
  while (set <= rise) set += DAY_MS;
  while (set - rise >= DAY_MS) set -= DAY_MS;
  const t = now.getTime();
  const shift = Math.floor((t - rise) / DAY_MS) * DAY_MS;
  rise += shift;
  set += shift;
  const deg =
    t < set
      ? NOON_PEAK_DEG * Math.sin((Math.PI * (t - rise)) / (set - rise))
      : -MIDNIGHT_DEPTH_DEG * Math.sin((Math.PI * (t - set)) / (rise + DAY_MS - set));
  return Math.min(90, Math.max(-18, deg));
}

export function createSceneEnv(deps: SceneEnvDeps) {
  let now = $state.raw(deps.now());
  let manualWeather = $state<Condition | null>(null);
  let manualMoon = $state<number | null>(null);
  let lookup = $state.raw<(() => BoundSnapshots) | null>(null);

  const weather = $derived.by<Condition | null>(() => {
    if (manualWeather) return manualWeather;
    const parsed = WeatherCondition.safeParse((lookup?.().weather as { condition?: unknown } | undefined)?.condition);
    return parsed.success ? parsed.data : null;
  });
  const moonPhase = $derived.by<number | null>(() => {
    if (manualMoon !== null) return manualMoon;
    const phase = (lookup?.().moon as { phase?: unknown } | undefined)?.phase;
    return typeof phase === 'number' && phase >= 0 && phase <= 1 ? phase : null;
  });
  const sunAltitudeDeg = $derived(approximateSunAltitude(now, deps.sun()));

  // ---- minute ticker: one timer, stopped while the document is hidden ----
  let timer: unknown = null;
  let started = false;
  const stopTimer = (): void => {
    if (timer !== null) deps.clearInterval(timer);
    timer = null;
  };
  const sync = (): void => {
    if (!started) return;
    if (deps.document?.hidden) {
      stopTimer();
      return;
    }
    now = deps.now(); // catch up after being hidden
    if (timer === null) timer = deps.setInterval(() => (now = deps.now()), TICK_MS);
  };

  const env: SceneEnv & {
    setWeather(c: Condition | null): void;
    setMoonPhase(p: number | null): void;
    /**
     * Wire in the user's weather/moon snapshots. `lookup` is called inside reactive contexts and returns the
     * `data` of the snapshots to use (e.g. the first visible weather and moon instance); the host reads only
     * `condition` (weather.updated) and `phase` (moon.updated). Explicit setters take precedence. Pass null to unbind.
     */
    bindSnapshots(lookup: (() => BoundSnapshots) | null): void;
    /** Start/stop the minute ticker (the background host does this). */
    start(): void;
    stop(): void;
  } = {
    get sunAltitudeDeg() {
      return sunAltitudeDeg;
    },
    get weather() {
      return weather;
    },
    get moonPhase() {
      return moonPhase;
    },
    get now() {
      return now;
    },
    setWeather: (c) => void (manualWeather = c),
    setMoonPhase: (p) => void (manualMoon = p),
    bindSnapshots: (l) => void (lookup = l),
    start() {
      if (started) return;
      started = true;
      deps.document?.addEventListener('visibilitychange', sync);
      sync();
    },
    stop() {
      started = false;
      deps.document?.removeEventListener('visibilitychange', sync);
      stopTimer();
    },
  };
  return env;
}
export type SceneEnvStore = ReturnType<typeof createSceneEnv>;

const hasDom = typeof document !== 'undefined';

export const sceneEnv = createSceneEnv({
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- the clock, not reactive state
  now: () => new Date(),
  sun: () => {
    const data = stream.snapshots['core:sun']?.data as Partial<SunTimes> | undefined;
    return data && typeof data.sunrise === 'string' && typeof data.sunset === 'string' ? { sunrise: data.sunrise, sunset: data.sunset } : null;
  },
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  document: hasDom ? document : undefined,
});
