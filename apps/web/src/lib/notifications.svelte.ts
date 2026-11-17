import { NotificationDto, StreamEvent } from '@dash/contract';
import { z } from 'zod';
import { api as defaultApi } from './api.js';
import { stream as defaultStream } from './stream.svelte.js';

export type Notification = z.infer<typeof NotificationDto>;
type Ev = z.infer<typeof StreamEvent>;

export const LATEST = 20;
const TOAST_MS = 6000;
const MAX_TOASTS = 4;

export interface Toast {
  key: number;
  notification: Notification;
}

export interface NotificationsDeps {
  api: {
    get<T>(path: string, schema?: z.ZodType<T>): Promise<T>;
    post<T>(path: string, body?: unknown): Promise<T>;
  };
  stream: { on(type: 'notification', fn: (e: Extract<Ev, { type: 'notification' }>) => void): () => void };
  now: () => Date;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
}

/**
 * The newest notifications of the signed-in user, the unread count and the toasts for arriving ones.
 * `start()` after sign-in, `clear()` on sign-out.
 */
export function createNotifications(deps: NotificationsDeps) {
  let items = $state<Notification[]>([]);
  let toasts = $state<Toast[]>([]);
  let loaded = $state(false);
  const unread = $derived(items.filter((n) => n.readAt === null).length);
  const timers = new Map<number, unknown>(); // eslint-disable-line svelte/prefer-svelte-reactivity -- bookkeeping
  let unsubscribe: (() => void) | null = null;
  let generation = 0;
  let toastKey = 0;

  function dismissToast(key: number): void {
    const h = timers.get(key);
    if (h !== undefined) deps.clearTimeout(h);
    timers.delete(key);
    toasts = toasts.filter((t) => t.key !== key);
  }

  function raise(n: Notification): void {
    const key = ++toastKey;
    toasts = [...toasts, { key, notification: n }].slice(-MAX_TOASTS);
    // Critical ones stay until dismissed; the others fade after a while.
    if (n.level !== 'critical') timers.set(key, deps.setTimeout(() => dismissToast(key), TOAST_MS));
  }

  async function load(): Promise<void> {
    const gen = generation;
    try {
      const list = await deps.api.get(`/notifications?limit=${LATEST}`, z.array(NotificationDto));
      if (gen !== generation) return;
      // Keep anything that arrived on the stream while the request was in flight.
      const known = new Set(list.map((n) => n.id)); // eslint-disable-line svelte/prefer-svelte-reactivity -- local
      items = [...items.filter((n) => !known.has(n.id)), ...list]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, LATEST);
      loaded = true;
    } catch {
      /* the bell simply stays empty; the next sign-in or reload tries again */
    }
  }

  function start(): void {
    if (unsubscribe) return;
    unsubscribe = deps.stream.on('notification', (e) => {
      const n = e.notification;
      if (items.some((x) => x.id === n.id)) {
        items = items.map((x) => (x.id === n.id ? n : x)); // an updated (deduplicated) notification
        return;
      }
      items = [n, ...items].slice(0, LATEST);
      raise(n);
    });
    void load();
  }

  /**
   * Mark notifications read. The change shows at once; if the request fails, the previous state returns.
   * Returns whether the server accepted it.
   */
  async function markRead(ids: string[] | 'all'): Promise<boolean> {
    const gen = generation;
    const at = deps.now().toISOString();
    const before = new Map(items.map((n) => [n.id, n.readAt])); // eslint-disable-line svelte/prefer-svelte-reactivity -- local
    const target = ids === 'all' ? null : new Set(ids); // eslint-disable-line svelte/prefer-svelte-reactivity -- local
    const changed: string[] = [];
    items = items.map((n) => {
      if (n.readAt !== null || (target && !target.has(n.id))) return n;
      changed.push(n.id);
      return { ...n, readAt: at };
    });
    if (ids !== 'all' && changed.length === 0) return true;
    try {
      await deps.api.post('/notifications/read', { ids });
      return true;
    } catch {
      if (gen === generation) {
        const back = new Set(changed); // eslint-disable-line svelte/prefer-svelte-reactivity -- local
        items = items.map((n) => (back.has(n.id) ? { ...n, readAt: before.get(n.id) ?? null } : n));
      }
      return false;
    }
  }

  function clear(): void {
    generation++;
    unsubscribe?.();
    unsubscribe = null;
    for (const h of timers.values()) deps.clearTimeout(h);
    timers.clear();
    items = [];
    toasts = [];
    loaded = false;
  }

  return {
    get items() {
      return items;
    },
    get unread() {
      return unread;
    },
    get toasts() {
      return toasts;
    },
    get loaded() {
      return loaded;
    },
    start,
    load,
    markRead,
    dismissToast,
    clear,
  };
}

export const notifications = createNotifications({
  api: defaultApi,
  stream: defaultStream,
  now: () => new Date(), // eslint-disable-line svelte/prefer-svelte-reactivity -- the clock, not state
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});

/** A notification link is followed in-app only when it is a same-origin relative path. */
export function isSafeAppUrl(url: string | null): url is string {
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\') && !/[\u0000-\u001f\u007f]/.test(url);
}
