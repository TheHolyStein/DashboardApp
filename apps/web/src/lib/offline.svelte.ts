import type { PageDto, SnapshotDto } from '@dash/contract';
import type { z } from 'zod';
import { pages as defaultPages } from './pages.svelte.js';
import { session as defaultSession } from './session.svelte.js';
import { recallTheme } from './prefs.js';
import { stream as defaultStream } from './stream.svelte.js';

type Page = z.infer<typeof PageDto>;
type Snapshot = z.infer<typeof SnapshotDto>;

export const OFFLINE_KEY = 'dash:offline:v1';
export const WRITE_EVERY_MS = 10_000;
export const MAX_BYTES = 2_000_000;
const RETRY_MS = 15_000;

export interface StoredState {
  v: 1;
  pages: Page[];
  snapshots: Record<string, Snapshot>;
}

/** Serialise, dropping the largest snapshots until the text fits `max`. Pure. */
export function serialize(state: StoredState, max = MAX_BYTES): string {
  const text = JSON.stringify(state);
  if (text.length <= max) return text;
  const sizes = Object.entries(state.snapshots)
    .map(([id, s]) => [id, JSON.stringify(s).length] as const)
    .sort((a, b) => b[1] - a[1]);
  const kept = { ...state.snapshots };
  for (const [id] of sizes) {
    delete kept[id];
    const next = JSON.stringify({ ...state, snapshots: kept });
    if (next.length <= max) return next;
  }
  return JSON.stringify({ ...state, snapshots: {} });
}

export interface OfflineDeps {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  window: { addEventListener(t: string, fn: () => void): void; removeEventListener(t: string, fn: () => void): void };
  pages: { list: Page[]; restore: (p: Page[]) => void };
  stream: { snapshots: Record<string, Snapshot>; on(t: 'snapshot' | 'layout', fn: () => void): () => void };
  session: { me: unknown; status: 'loading' | 'signedOut' | 'signedIn'; refresh(): Promise<void> };
}

/**
 * Last-known state for offline starts: the page layout and the snapshots, in `sessionStorage`, written at most
 * every 10 s and on `pagehide`, capped at about 2 MB, removed on sign-out. Nothing else is kept (no csrf token,
 * no user data, no notifications).
 */
export function createOffline(deps: OfflineDeps) {
  let restored = $state(false);
  let dirty = false;
  let lastWrite = -Infinity;
  let timer: unknown = null;
  let retry: unknown = null;
  let unsubs: Array<() => void> = [];
  let active = false;

  function snapshotState(): StoredState {
    const snaps: Record<string, Snapshot> = {};
    for (const [id, s] of Object.entries(deps.stream.snapshots)) {
      if (id.startsWith('core:')) continue;
      snaps[id] = { instanceId: s.instanceId, data: s.data, updatedAt: s.updatedAt, stale: s.stale };
    }
    return { v: 1, pages: JSON.parse(JSON.stringify(deps.pages.list)) as Page[], snapshots: snaps };
  }

  function write(): void {
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
    dirty = false;
    if (!deps.storage || restored || deps.pages.list.length === 0) return;
    lastWrite = deps.now();
    try {
      deps.storage.setItem(OFFLINE_KEY, serialize(snapshotState()));
    } catch {
      /* quota or private mode: offline start simply has nothing to restore */
    }
  }

  function markDirty(): void {
    if (!active) return;
    dirty = true;
    if (timer !== null) return;
    const wait = Math.max(0, lastWrite + WRITE_EVERY_MS - deps.now());
    timer = deps.setTimeout(write, wait);
  }

  const onPageHide = (): void => {
    if (active && dirty) write();
  };
  const onOnline = (): void => void tryReconnect();

  async function tryReconnect(): Promise<void> {
    if (!restored) return;
    try {
      await deps.session.refresh();
    } catch {
      return; // still offline: keep showing stored data, try again later
    }
    if (deps.session.status !== 'signedIn' || !restored) return;
    restored = false; // the shell reacts to this: it loads the pages and starts collecting again
    stopRetry();
  }
  function stopRetry(): void {
    if (retry !== null) deps.clearInterval(retry);
    retry = null;
    deps.window.removeEventListener('online', onOnline);
  }

  return {
    get restored() {
      return restored;
    },
    /** Begin collecting (signed in, live). */
    start(): void {
      if (active) return;
      active = true;
      unsubs = [deps.stream.on('snapshot', markDirty), deps.stream.on('layout', markDirty)];
      deps.window.addEventListener('pagehide', onPageHide);
      markDirty();
    },
    markDirty,
    /** Stop collecting; the stored state stays (use `clear` on sign-out). */
    stop(): void {
      active = false;
      for (const u of unsubs) u();
      unsubs = [];
      deps.window.removeEventListener('pagehide', onPageHide);
      if (timer !== null) deps.clearTimeout(timer);
      timer = null;
    },
    read(): StoredState | null {
      try {
        const raw = deps.storage?.getItem(OFFLINE_KEY);
        if (!raw) return null;
        const v = JSON.parse(raw) as Partial<StoredState>;
        if (v.v !== 1 || !Array.isArray(v.pages) || v.pages.length === 0 || typeof v.snapshots !== 'object' || !v.snapshots) return null;
        return v as StoredState;
      } catch {
        return null;
      }
    },
    /**
     * The session request failed and a stored state exists: show it with every snapshot marked stale, using a
     * placeholder user that can only view (grants are derived from the stored tiles, nothing is stored about
     * the user), and retry the session quietly. Returns false when there is nothing to restore.
     */
    restore(): boolean {
      const stored = this.read();
      if (!stored) return false;
      const grants: Record<string, 'view'> = {};
      for (const p of stored.pages) for (const i of p.instances) grants[i.moduleId] = 'view';
      const prefs = recallTheme();
      restored = true;
      deps.session.me = { id: '', name: '', handle: '', role: 'member', grants, csrf: '', totpEnabled: false, prefs: { ...prefs, locale: 'en', timeZone: 'UTC' } };
      deps.session.status = 'signedIn';
      for (const [id, s] of Object.entries(stored.snapshots)) deps.stream.snapshots[id] = { ...s, stale: true };
      deps.pages.restore(stored.pages);
      retry = deps.setInterval(() => void tryReconnect(), RETRY_MS);
      deps.window.addEventListener('online', onOnline);
      return true;
    },
    tryReconnect,
    /** Sign-out: forget everything. */
    clear(): void {
      this.stop();
      stopRetry();
      restored = false;
      try {
        deps.storage?.removeItem(OFFLINE_KEY);
      } catch {
        /* ignore */
      }
    },
  };
}

function sessionStorageOrNull(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export const offline = createOffline({
  storage: sessionStorageOrNull(),
  now: () => performance.now() + performance.timeOrigin,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  window,
  pages: defaultPages,
  stream: defaultStream,
  session: defaultSession,
});
