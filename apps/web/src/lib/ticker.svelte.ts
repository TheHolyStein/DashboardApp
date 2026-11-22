export const TICK_MS = 30_000;

export interface TickerDeps {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  isVisible: () => boolean;
  document: { addEventListener(type: 'visibilitychange', fn: () => void): void; removeEventListener(type: 'visibilitychange', fn: () => void): void };
  now: () => Date;
}

/** One shared timer for everything that shows relative times. Runs only with subscribers and a visible document. */
export function createTicker(deps: TickerDeps) {
  let now = $state(deps.now());
  let subscribers = 0;
  let timer: unknown = null;
  let listening = false;

  const stop = (): void => {
    if (timer !== null) deps.clearInterval(timer);
    timer = null;
  };
  const start = (): void => {
    if (timer === null) timer = deps.setInterval(() => (now = deps.now()), TICK_MS);
  };
  const sync = (): void => {
    if (subscribers > 0 && deps.isVisible()) start();
    else stop();
  };
  const onVisibility = (): void => {
    if (deps.isVisible() && subscribers > 0) now = deps.now(); // catch up right away after being hidden
    sync();
  };

  return {
    get now(): Date {
      return now;
    },
    /** Returns the unsubscribe function. */
    subscribe(): () => void {
      subscribers++;
      if (!listening) {
        listening = true;
        deps.document.addEventListener('visibilitychange', onVisibility);
      }
      now = deps.now();
      sync();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        subscribers--;
        if (subscribers === 0 && listening) {
          listening = false;
          deps.document.removeEventListener('visibilitychange', onVisibility);
        }
        sync();
      };
    },
    /** Whether the timer is currently running (for tests). */
    get running(): boolean {
      return timer !== null;
    },
  };
}

export const ticker = createTicker({
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  isVisible: () => document.visibilityState !== 'hidden',
  document,
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain timestamps; reactivity comes from the `now` state
  now: () => new Date(),
});
