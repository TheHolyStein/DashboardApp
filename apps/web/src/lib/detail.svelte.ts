/* eslint-disable svelte/prefer-svelte-reactivity -- URLSearchParams here is a short-lived parser/serializer, not reactive state. */
const PARAM_PREFIX = 'dp.';

export interface DetailDeps {
  history: Pick<History, 'pushState' | 'replaceState' | 'back'>;
  location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  window: { addEventListener(type: 'popstate', fn: () => void): void; removeEventListener(type: 'popstate', fn: () => void): void };
}

export interface DetailState {
  id: string;
  params: Record<string, string>;
}

/** Reads `?d=<id>&dp.<k>=<v>` from a query string. */
export function parseDetail(search: string): DetailState | null {
  const q = new URLSearchParams(search);
  const id = q.get('d');
  if (!id) return null;
  const params: Record<string, string> = {};
  for (const [k, v] of q) if (k.startsWith(PARAM_PREFIX) && k.length > PARAM_PREFIX.length) params[k.slice(PARAM_PREFIX.length)] = v;
  return { id, params };
}

/** The open detail pane, mirrored in the URL (`?d=<instanceId>` plus `dp.*` params). One pane at a time. */
export function createDetail(deps: DetailDeps) {
  let state = $state<DetailState | null>(parseDetail(deps.location.search));
  let pushed = false; // the open pane has a history entry created in this session
  // Where focus goes when the pane closes, when it was opened from a frame click (no focused opener). Kept after
  // close so the pane can read it while unmounting; replaced by the next open.
  let returnTo: HTMLElement | null = null;

  function urlWith(next: DetailState | null): string {
    const q = new URLSearchParams(deps.location.search);
    q.delete('d');
    for (const k of [...q.keys()]) if (k.startsWith(PARAM_PREFIX)) q.delete(k);
    if (next) {
      q.set('d', next.id);
      for (const [k, v] of Object.entries(next.params)) q.set(PARAM_PREFIX + k, v);
    }
    const s = q.toString();
    return `${deps.location.pathname}${s ? `?${s}` : ''}${deps.location.hash}`;
  }

  function onPopState(): void {
    state = parseDetail(deps.location.search);
    if (!state) pushed = false;
  }
  deps.window.addEventListener('popstate', onPopState);

  return {
    get current(): DetailState | null {
      return state;
    },
    /** Element to focus when the pane closes, if the opener recorded one. */
    get returnTo(): HTMLElement | null {
      return returnTo;
    },
    /** Open (or switch to) the pane for an instance. Opening from closed pushes a history entry. `focusAfter` is where focus returns on close. */
    open(id: string, params: Record<string, string> = {}, focusAfter: HTMLElement | null = null): void {
      returnTo = focusAfter;
      const next = { id, params };
      if (state) deps.history.replaceState(null, '', urlWith(next));
      else {
        deps.history.pushState(null, '', urlWith(next));
        pushed = true;
      }
      state = next;
    },
    /** Close: Back when this session pushed the entry, otherwise replace the URL. */
    close(): void {
      if (!state) return;
      if (pushed) deps.history.back(); // popstate updates the state
      else this.drop();
    },
    /** Remove the pane from the URL without adding history (also for ids the user cannot see). */
    drop(): void {
      if (!state) return;
      deps.history.replaceState(null, '', urlWith(null));
      state = null;
      pushed = false;
    },
    /** Re-read the URL (what a popstate does); also used by tests to reset. */
    sync: onPopState,
    destroy(): void {
      deps.window.removeEventListener('popstate', onPopState);
    },
  };
}

export const detail = createDetail({ history: window.history, location: window.location, window });
