// Time helpers shared by the Clock tile and detail: a ticking `now`, a stopwatch and a few formatters.
// Call `useNow` and `createStopwatch` while a component initialises (they register effects).

export interface UseNowOptions {
  /** Tick every second (true) or once on each minute boundary (false). May be a getter to change at runtime. */
  seconds: boolean;
}

/** Injection points for tests; the defaults are the real clock and `document`. */
export interface UseNowDeps {
  clock?: () => Date;
  doc?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
}

/**
 * A reactive `now`. One `setTimeout`, re-armed to the next second or minute boundary (never a 1 s
 * interval when seconds are off). Stops while the document is hidden and re-syncs on becoming visible.
 * `opts.seconds` is read inside an effect, so pass an object with a getter to switch rates at runtime.
 */
export function useNow(opts: UseNowOptions, deps: UseNowDeps = {}): { readonly now: Date } {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- the Date is never mutated; `now` is replaced as a whole
  const clock = deps.clock ?? (() => new Date());
  const doc = deps.doc ?? (typeof document === 'undefined' ? undefined : document);
  let now = $state.raw(clock());

  $effect(() => {
    const step = opts.seconds ? 1000 : 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const stop = (): void => {
      clearTimeout(timer);
      timer = undefined;
    };
    const sync = (): void => {
      stop();
      const current = clock();
      now = current;
      // Time left until the next boundary of `step`; a full step when exactly on it.
      const sinceBoundary = (opts.seconds ? 0 : current.getSeconds() * 1000) + current.getMilliseconds();
      timer = setTimeout(sync, step - sinceBoundary);
    };
    const onVisibility = (): void => {
      if (doc?.hidden) stop();
      else sync();
    };

    if (!doc?.hidden) sync();
    doc?.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      doc?.removeEventListener('visibilitychange', onVisibility);
    };
  });

  return {
    get now() {
      return now;
    },
  };
}

export interface Stopwatch {
  readonly running: boolean;
  /** Elapsed milliseconds, refreshed about every 100 ms while running. */
  readonly elapsedMs: number;
  /** Lap marks as cumulative elapsed milliseconds, oldest first. */
  readonly laps: readonly number[];
  start(): void;
  stop(): void;
  lap(): void;
  reset(): void;
  dispose(): void;
}

const REFRESH_MS = 100;

/** Client-only stopwatch based on `performance.now()` deltas; `clock` is injectable for tests. */
export function createStopwatch(clock: () => number = () => performance.now()): Stopwatch {
  let startedAt = $state<number | null>(null); // clock value at the last start, null while stopped
  let carried = $state(0); // elapsed before the last start
  let frame = $state(0); // last clock reading, drives re-rendering
  let laps = $state<number[]>([]);
  let interval: ReturnType<typeof setInterval> | undefined;

  const total = (at: number): number => carried + (startedAt === null ? 0 : Math.max(0, at - startedAt));
  const halt = (): void => {
    clearInterval(interval);
    interval = undefined;
  };

  return {
    get running() {
      return startedAt !== null;
    },
    get elapsedMs() {
      return startedAt === null ? carried : total(frame);
    },
    get laps() {
      return laps;
    },
    start() {
      if (startedAt !== null) return;
      startedAt = frame = clock();
      interval = setInterval(() => (frame = clock()), REFRESH_MS);
    },
    stop() {
      if (startedAt === null) return;
      carried = total(clock());
      startedAt = null;
      halt();
    },
    lap() {
      if (startedAt !== null) laps = [...laps, total(clock())];
    },
    reset() {
      halt();
      startedAt = null;
      carried = 0;
      laps = [];
    },
    dispose: halt,
  };
}

/** IANA zone of the viewer's device. */
export const userZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

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

/** Wall-clock text for `timeZone`: `HH:mm` (with seconds when asked). */
export function formatTime(now: Date, o: { timeZone: string; hour12: boolean; seconds: boolean }): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: o.seconds ? '2-digit' : undefined,
    hourCycle: o.hour12 ? 'h12' : 'h23',
    timeZone: o.timeZone,
  }).format(now);
}
