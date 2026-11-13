/* eslint-disable svelte/prefer-svelte-reactivity -- Map/Set here are internal, non-reactive bookkeeping; only `snapshots` and `status` are reactive. */
import { StreamEvent, type InstanceId, type ModuleId, type SnapshotDto } from '@dash/contract';
import type { z } from 'zod';
import { api } from './api.js';

type Snapshot = z.infer<typeof SnapshotDto>;
type Ev = z.infer<typeof StreamEvent>;
export type StreamEventType = Ev['type'];
export type StreamStatus = 'connecting' | 'live' | 'offline';

export interface EventSourceLike {
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  close(): void;
}
export interface Target {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}
export interface StreamDeps {
  EventSource: (new (url: string) => EventSourceLike) | undefined;
  post: (path: string, body: unknown) => Promise<unknown>;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (h: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
  random: () => number;
  isOnline: () => boolean;
  isVisible: () => boolean;
  window: Target;
  document: Target;
}

const MAX_VIEW = 200;
const DEAD_MS = 60_000;
const HEARTBEAT_MS = 30_000;
const DEBOUNCE_MS = 250;
const BACKOFF_BASE = 1000;
const BACKOFF_MAX = 30_000;

export function createStream(deps: StreamDeps) {
  const snapshots = $state<Record<InstanceId, Snapshot>>({});
  let status = $state<StreamStatus>('offline');

  let active = false;
  let src: EventSourceLike | null = null;
  let gotEvent = false;
  let invalidCount = 0;
  let pending: Set<string> | null = null;
  let attempts = 0;
  let backoffTimer: unknown = null;
  let watchdog: unknown = null;
  let debounceTimer: unknown = null;
  let heartbeat: unknown = null;
  let visibleIds: string[] = [];
  let instanceModules: Record<InstanceId, ModuleId> = {};
  const listeners = new Map<StreamEventType, Set<(e: never) => void>>();

  function clearBackoff(): void {
    if (backoffTimer !== null) deps.clearTimeout(backoffTimer);
    backoffTimer = null;
  }
  function clearWatchdog(): void {
    if (watchdog !== null) deps.clearTimeout(watchdog);
    watchdog = null;
  }
  function closeSource(): void {
    clearWatchdog();
    if (src) {
      src.onmessage = null;
      src.onerror = null;
      src.close();
      src = null;
    }
  }
  function armWatchdog(): void {
    clearWatchdog();
    watchdog = deps.setTimeout(() => {
      watchdog = null;
      closeSource();
      status = 'offline';
      open();
    }, DEAD_MS);
  }

  function open(): void {
    clearBackoff();
    closeSource();
    if (!active || !deps.EventSource) return;
    if (!deps.isOnline()) {
      status = 'offline'; // wait for the `online` event
      return;
    }
    status = 'connecting';
    gotEvent = false;
    invalidCount = 0;
    pending = null;
    const es = new deps.EventSource('/api/stream');
    src = es;
    es.onmessage = (m) => {
      if (src === es) onMessage(m.data);
    };
    es.onerror = () => {
      if (src === es) onError();
    };
    armWatchdog();
  }

  function onError(): void {
    if (gotEvent) attempts = 0; // the connection was healthy
    closeSource();
    status = 'offline';
    if (!active) return;
    if (!deps.isOnline()) return; // wait for `online`
    const exp = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** attempts);
    attempts++;
    const delay = exp * (0.5 + 0.5 * deps.random());
    clearBackoff();
    backoffTimer = deps.setTimeout(() => {
      backoffTimer = null;
      open();
    }, delay);
  }

  function onMessage(raw: unknown): void {
    armWatchdog();
    let parsed: ReturnType<typeof StreamEvent.safeParse>;
    try {
      parsed = StreamEvent.safeParse(JSON.parse(String(raw)));
    } catch {
      parsed = { success: false } as typeof parsed;
    }
    if (!parsed.success) {
      if (invalidCount++ === 0) console.debug('[stream] dropped invalid message');
      return;
    }
    const ev = parsed.data;
    if (!gotEvent) {
      gotEvent = true;
      status = 'live';
      pending = new Set(Object.keys(snapshots));
      postView();
    }
    switch (ev.type) {
      case 'snapshot':
        snapshots[ev.snapshot.instanceId] = ev.snapshot;
        pending?.delete(ev.snapshot.instanceId);
        break;
      case 'ping':
        if (pending) {
          for (const id of pending) if (!id.startsWith('core:')) delete snapshots[id];
          pending = null;
        }
        break;
      case 'revoked':
        for (const [iid, mid] of Object.entries(instanceModules)) {
          if (mid === ev.moduleId) {
            delete snapshots[iid];
            pending?.delete(iid);
          }
        }
        break;
      default:
        break;
    }
    const set = listeners.get(ev.type);
    if (set) {
      for (const fn of [...set]) {
        try {
          (fn as (e: Ev) => void)(ev);
        } catch (e) {
          console.error('[stream] listener failed', e);
        }
      }
    }
  }

  function reconnectNow(): void {
    if (!active || status === 'live') return;
    open();
  }

  function postView(): void {
    if (!active || !deps.isVisible() || status === 'offline' || visibleIds.length === 0) return;
    deps.post('/stream/view', { instanceIds: visibleIds }).catch(() => {});
  }

  function syncHeartbeat(): void {
    const want = active && deps.isVisible() && visibleIds.length > 0;
    if (want && heartbeat === null) heartbeat = deps.setInterval(postView, HEARTBEAT_MS);
    else if (!want && heartbeat !== null) {
      deps.clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  const onOnline = (): void => reconnectNow();
  const onVisibility = (): void => {
    syncHeartbeat();
    if (deps.isVisible()) {
      reconnectNow();
      postView();
    }
  };

  return {
    get snapshots() {
      return snapshots;
    },
    get status() {
      return status;
    },
    connect(): void {
      if (active) return;
      active = true;
      deps.window.addEventListener('online', onOnline);
      deps.document.addEventListener('visibilitychange', onVisibility);
      attempts = 0;
      open();
      syncHeartbeat();
    },
    disconnect(): void {
      active = false;
      closeSource();
      clearBackoff();
      if (debounceTimer !== null) deps.clearTimeout(debounceTimer);
      debounceTimer = null;
      if (heartbeat !== null) deps.clearInterval(heartbeat);
      heartbeat = null;
      deps.window.removeEventListener('online', onOnline);
      deps.document.removeEventListener('visibilitychange', onVisibility);
      for (const k of Object.keys(snapshots)) delete snapshots[k];
      pending = null;
      visibleIds = [];
      instanceModules = {};
      status = 'offline';
    },
    setVisible(ids: InstanceId[]): void {
      const next = [...new Set(ids)].slice(0, MAX_VIEW);
      const changed = next.length !== visibleIds.length || next.some((v, i) => v !== visibleIds[i]);
      visibleIds = next;
      syncHeartbeat();
      if (!changed || !active) return;
      if (debounceTimer !== null) deps.clearTimeout(debounceTimer);
      debounceTimer = deps.setTimeout(() => {
        debounceTimer = null;
        postView();
      }, DEBOUNCE_MS);
    },
    /** Instance -> module mapping, needed to apply `revoked` events. The pages store calls it whenever pages load. */
    setInstanceModules(map: Record<InstanceId, ModuleId>): void {
      instanceModules = { ...map };
    },
    on<T extends StreamEventType>(type: T, fn: (e: Extract<Ev, { type: T }>) => void): () => void {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },
  };
}

export const stream = createStream({
  EventSource: typeof EventSource === 'undefined' ? undefined : (EventSource as unknown as StreamDeps['EventSource']),
  post: (path, body) => api.post(path, body),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  random: () => Math.random(),
  isOnline: () => navigator.onLine,
  isVisible: () => document.visibilityState === 'visible',
  window,
  document,
});
