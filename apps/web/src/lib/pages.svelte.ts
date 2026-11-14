/* eslint-disable svelte/prefer-svelte-reactivity -- Map/Set here are internal, non-reactive bookkeeping. */
import { PageDto, type InstanceId, type ModuleId } from '@dash/contract';
import { z } from 'zod';
import { api as defaultApi } from './api.js';
import { session } from './session.svelte.js';
import { stream as defaultStream } from './stream.svelte.js';
import type { Layout } from './grid.js';

export type Page = z.infer<typeof PageDto>;
export type LayoutItem = { id: string; layout: Layout; mobileOrder: number };
export type PagesStatus = 'idle' | 'loading' | 'ready' | 'error';

export const SAVE_DEBOUNCE_MS = 500;
const PAGE_PATH = /^\/p\/([^/]+)\/?$/;

export interface PagesDeps {
  api: { get<T>(path: string, schema?: z.ZodType<T>): Promise<T>; put<T>(path: string, body?: unknown): Promise<T> };
  stream: {
    setInstanceModules(map: Record<InstanceId, ModuleId>): void;
    on(type: 'layout', fn: (e: { type: 'layout'; pageId: string }) => void): () => void;
  };
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  history: Pick<History, 'pushState' | 'replaceState'>;
  location: Pick<Location, 'pathname' | 'search' | 'hash'>;
  getUserId: () => string | null;
  window: { addEventListener(type: 'popstate', fn: () => void): void; removeEventListener(type: 'popstate', fn: () => void): void };
}

export function createPages(deps: PagesDeps) {
  let list = $state<Page[]>([]);
  let status = $state<PagesStatus>('idle');
  let currentId = $state<string | null>(null);
  let editing = $state(false);
  const current = $derived(list.find((p) => p.id === currentId) ?? null);

  const pending = new Map<string, { items: LayoutItem[]; timer: unknown; due: boolean }>();
  const failedLast = new Set<string>();
  const saving = new Set<string>();
  const deferred = new Set<string>();
  let loadSeq = 0;

  const idFromUrl = (): string | null => {
    const m = PAGE_PATH.exec(deps.location.pathname);
    if (!m?.[1]) return null;
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return null;
    }
  };
  const urlFor = (id: string): string => `/p/${encodeURIComponent(id)}${deps.location.search}${deps.location.hash}`;

  /** Make currentId valid: unknown or missing falls back to the first page and replaces the URL. */
  function settle(): void {
    if (list.length === 0) return;
    if (currentId === null || !list.some((p) => p.id === currentId)) {
      currentId = list[0]!.id;
      deps.history.replaceState(null, '', urlFor(currentId));
    }
  }

  function publishModules(): void {
    const map: Record<InstanceId, ModuleId> = {};
    for (const p of list) for (const i of p.instances) map[i.id] = i.moduleId;
    deps.stream.setInstanceModules(map);
  }

  const isBusy = (pageId: string): boolean => pending.has(pageId) || saving.has(pageId);

  async function fetchPages(): Promise<Page[] | null> {
    const seq = ++loadSeq;
    const fresh = await deps.api.get('/pages', z.array(PageDto));
    return seq === loadSeq ? fresh : null; // a newer request supersedes this one
  }

  function apply(fresh: Page[], only?: string): void {
    if (only === undefined) {
      // Keep the local copy of pages with unsaved layout changes.
      list = fresh.map((p) => (isBusy(p.id) ? (list.find((o) => o.id === p.id) ?? p) : p));
    } else {
      list = fresh.map((p) => (p.id === only || !list.some((o) => o.id === p.id) ? p : (list.find((o) => o.id === p.id) ?? p)));
    }
    settle();
    publishModules();
  }

  async function load(): Promise<void> {
    if (status !== 'ready') status = 'loading';
    try {
      const fresh = await fetchPages();
      if (!fresh) return;
      apply(fresh);
      status = 'ready';
    } catch {
      status = 'error';
    }
  }

  async function reload(pageId?: string): Promise<void> {
    if (pageId === undefined) return load();
    try {
      const fresh = await fetchPages();
      if (fresh) apply(fresh, pageId);
    } catch {
      /* keep what we have; the next event or load retries */
    }
  }

  function settleDeferred(pageId: string): void {
    if (deferred.has(pageId) && !editing && !isBusy(pageId)) {
      deferred.delete(pageId);
      void reload(pageId);
    }
  }

  /** At most one PUT in flight per page; a newer value waits (as the single pending one) until it settles. */
  async function flush(pageId: string): Promise<void> {
    const entry = pending.get(pageId);
    if (!entry || saving.has(pageId)) return;
    pending.delete(pageId);
    saving.add(pageId);
    let failed = false;
    try {
      await deps.api.put(`/pages/${encodeURIComponent(pageId)}/layout`, { items: entry.items });
    } catch {
      failed = true;
    } finally {
      saving.delete(pageId);
    }
    if (failed) failedLast.add(pageId);
    else failedLast.delete(pageId);
    const next = pending.get(pageId);
    if (next?.due) return flush(pageId); // newer value already past its debounce
    if (!next && failedLast.delete(pageId)) deferred.add(pageId); // refetch the server's version once idle
    settleDeferred(pageId);
  }

  function saveLayout(pageId: string, items: LayoutItem[]): void {
    const target = list.find((p) => p.id === pageId);
    if (!editing || !target || target.ownerId !== deps.getUserId()) return; // owner-only, edit mode only
    // Optimistic local update so views stay consistent while the PUT is pending.
    list = list.map((p) =>
      p.id === pageId
        ? {
            ...p,
            instances: p.instances.map((i) => {
              const it = items.find((x) => x.id === i.id);
              return it ? { ...i, layout: it.layout, mobileOrder: it.mobileOrder } : i;
            }),
          }
        : p,
    );
    const prev = pending.get(pageId);
    // Merge with an unsent burst for the same page: later items win per instance.
    const merged = prev ? [...prev.items.filter((a) => !items.some((b) => b.id === a.id)), ...items] : items;
    if (prev) deps.clearTimeout(prev.timer);
    const entry = { items: merged, due: false, timer: null as unknown };
    entry.timer = deps.setTimeout(() => {
      entry.due = true;
      void flush(pageId);
    }, SAVE_DEBOUNCE_MS);
    pending.set(pageId, entry);
  }

  function onPopState(): void {
    currentId = idFromUrl();
    settle();
  }

  currentId = idFromUrl();
  deps.window.addEventListener('popstate', onPopState);
  const unsubscribe = deps.stream.on('layout', (e) => {
    if (editing || isBusy(e.pageId)) deferred.add(e.pageId);
    else void reload(e.pageId);
  });

  function select(id: string): void {
    if (!list.some((p) => p.id === id) || id === currentId) return;
    currentId = id;
    deps.history.pushState(null, '', urlFor(id));
  }
  function step(d: number): void {
    const i = list.findIndex((p) => p.id === currentId);
    const target = list[i + d];
    if (i >= 0 && target) select(target.id);
  }
  function clear(): void {
    loadSeq++;
    for (const e of pending.values()) deps.clearTimeout(e.timer);
    pending.clear();
    saving.clear();
    deferred.clear();
    failedLast.clear();
    list = [];
    deps.stream.setInstanceModules({});
    status = 'idle';
    editing = false;
  }

  return {
    get list() {
      return list;
    },
    get status() {
      return status;
    },
    get currentId() {
      return currentId;
    },
    get current() {
      return current;
    },
    get editing() {
      return editing;
    },
    load,
    reload,
    select,
    next: () => step(1),
    prev: () => step(-1),
    saveLayout,
    setEditing(on: boolean): void {
      editing = on;
      if (!on) for (const id of [...deferred]) settleDeferred(id);
    },
    /** Sign-out: drop everything, including unsent saves. */
    clear,
    destroy(): void {
      clear();
      unsubscribe();
      deps.window.removeEventListener('popstate', onPopState);
    },
  };
}

export const pages = createPages({
  api: defaultApi,
  stream: defaultStream,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  history: window.history,
  location: window.location,
  getUserId: () => session.me?.id ?? null,
  window,
});
