// A reactive `now` that moves once a minute (due dates and buckets do not need more). Call it while a component initialises.
// It stops while the document is hidden and re-syncs when it becomes visible.

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- the Date is never mutated; `now` is replaced as a whole
export function useMinute(clock: () => Date = () => new Date()): { readonly now: Date } {
  let now = $state.raw(clock());

  $effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = (): void => {
      clearTimeout(timer);
      timer = undefined;
    };
    const sync = (): void => {
      stop();
      const current = clock();
      now = current;
      timer = setTimeout(sync, 60_000 - (current.getSeconds() * 1000 + current.getMilliseconds()));
    };
    const onVisibility = (): void => {
      if (document.hidden) stop();
      else sync();
    };
    if (!document.hidden) sync();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });

  return {
    get now() {
      return now;
    },
  };
}
