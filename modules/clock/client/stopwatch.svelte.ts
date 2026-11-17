// Client-only stopwatch for the Clock detail. Call `createStopwatch` while a component initialises.

export interface Stopwatch {
  readonly running: boolean;
  /** Elapsed milliseconds, refreshed about every 100 ms while running and visible. */
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

/**
 * Based on `clock()` deltas (`performance.now()` by default; injectable for tests). The refresh interval is
 * paused while the document is hidden and the reading is re-synced when it becomes visible; elapsed time
 * is derived from the clock, so nothing is lost while hidden.
 */
export function createStopwatch(clock: () => number = () => performance.now()): Stopwatch {
  let startedAt = $state<number | null>(null); // clock value at the last start, null while stopped
  let carried = $state(0); // elapsed before the last start
  let frame = $state(0); // last clock reading, drives re-rendering
  let laps = $state<number[]>([]);
  let interval: ReturnType<typeof setInterval> | undefined;
  const doc = typeof document === 'undefined' ? undefined : document;

  const total = (at: number): number => carried + (startedAt === null ? 0 : Math.max(0, at - startedAt));
  const halt = (): void => {
    clearInterval(interval);
    interval = undefined;
  };
  const arm = (): void => {
    halt();
    if (startedAt !== null && !doc?.hidden) interval = setInterval(() => (frame = clock()), REFRESH_MS);
  };
  const onVisibility = (): void => {
    if (startedAt !== null) frame = clock();
    arm();
  };
  doc?.addEventListener('visibilitychange', onVisibility);

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
      arm();
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
    dispose() {
      halt();
      doc?.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
