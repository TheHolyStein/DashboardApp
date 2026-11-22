// A reactive `now` for the Clock tile and detail. Call `useNow` while a component initialises (it registers an effect).

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
