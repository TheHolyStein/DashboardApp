import { render, screen, waitFor } from '@testing-library/svelte';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOffline, MAX_BYTES, OFFLINE_KEY, serialize, WRITE_EVERY_MS, type OfflineDeps, type StoredState } from '../../src/lib/offline.svelte.js';
import { offline } from '../../src/lib/offline.svelte.js';
import { pages } from '../../src/lib/pages.svelte.js';
import { session } from '../../src/lib/session.svelte.js';
import { stream } from '../../src/lib/stream.svelte.js';
import App from '../../src/shell/App.svelte';
import { server } from '../setup.js';
import { makeMe } from './helpers.js';
import { inst, page } from './pageFixtures.js';

const snap = (id: string, data: unknown = {}) => ({ instanceId: id, data, updatedAt: '2026-11-17T10:00:00.000Z', stale: false });

function rig(over: Partial<OfflineDeps> = {}) {
  const store = new Map<string, string>();
  let clock = 1_000_000;
  const timers: Array<{ fn: () => void; ms: number; id: number }> = [];
  let tid = 0;
  const listeners: Record<string, Array<() => void>> = {};
  const streamHandlers: Record<string, Array<() => void>> = {};
  const deps: OfflineDeps = {
    storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) },
    now: () => clock,
    setTimeout: (fn, ms) => (timers.push({ fn, ms, id: ++tid }), tid),
    clearTimeout: (h) => void timers.splice(0, timers.length, ...timers.filter((t) => t.id !== h)),
    setInterval: () => 1,
    clearInterval: () => {},
    window: {
      addEventListener: (t, fn) => void (listeners[t] ??= []).push(fn),
      removeEventListener: (t, fn) => void (listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn)),
    },
    pages: { list: [page('p1', [inst('i1')])], restore: vi.fn() },
    stream: {
      snapshots: { i1: snap('i1', { a: 1 }), 'core:sun': snap('core:sun') },
      on: (t, fn) => ((streamHandlers[t] ??= []).push(fn), () => void (streamHandlers[t] = (streamHandlers[t] ?? []).filter((f) => f !== fn))),
    },
    session: { me: null, status: 'loading', refresh: () => Promise.reject(new Error('offline')) },
    ...over,
  };
  return {
    deps,
    store,
    timers,
    listeners,
    streamHandlers,
    off: createOffline(deps),
    advance: (ms: number) => void (clock += ms),
    runTimers: () => timers.splice(0).forEach((t) => t.fn()),
  };
}

const read = (store: Map<string, string>): StoredState => JSON.parse(store.get(OFFLINE_KEY) ?? 'null') as StoredState;

describe('offline store', () => {
  it('writes the layout and snapshots at most once every 10 s, and on pagehide', () => {
    const r = rig();
    r.off.start();
    r.runTimers(); // first write
    expect(read(r.store).pages).toHaveLength(1);
    expect(Object.keys(read(r.store).snapshots)).toEqual(['i1']); // core:* is not stored

    r.deps.stream.snapshots.i1 = snap('i1', { a: 2 });
    r.streamHandlers.snapshot?.forEach((h) => h());
    r.streamHandlers.snapshot?.forEach((h) => h());
    expect(r.timers).toHaveLength(1);
    expect(r.timers[0]?.ms).toBe(WRITE_EVERY_MS); // not before 10 s have passed
    r.advance(4000);
    r.streamHandlers.snapshot?.forEach((h) => h());
    expect(r.timers).toHaveLength(1);
    expect(read(r.store).snapshots.i1?.data).toEqual({ a: 1 });

    r.listeners.pagehide?.forEach((h) => h()); // pagehide writes at once
    expect(read(r.store).snapshots.i1?.data).toEqual({ a: 2 });
    expect(r.timers).toHaveLength(0);
  });

  it('the stored state never contains the csrf token, the user or notifications', () => {
    signedIn();
    const r = rig();
    r.off.start();
    r.runTimers();
    const text = r.store.get(OFFLINE_KEY) ?? '';
    expect(text).not.toContain('csrf-token');
    expect(text).not.toContain('Alice');
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(['pages', 'snapshots', 'v']);
  });

  it('drops the largest snapshots to stay under the size cap and keeps the layout', () => {
    const big = 'x'.repeat(900);
    const state: StoredState = {
      v: 1,
      pages: [page('p1', [inst('i1')])],
      snapshots: { a: snap('a', big), b: snap('b', 'small'), c: snap('c', big + big) },
    };
    const text = serialize(state, 1000);
    const out = JSON.parse(text) as StoredState;
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(Object.keys(out.snapshots)).toEqual(['b']);
    expect(out.pages).toHaveLength(1);
    expect(MAX_BYTES).toBe(2_000_000);
    expect((JSON.parse(serialize(state, 10)) as StoredState).snapshots).toEqual({}); // layout alone, even when over
  });

  it('clear() forgets the stored state', () => {
    const r = rig();
    r.off.start();
    r.runTimers();
    expect(r.store.has(OFFLINE_KEY)).toBe(true);
    r.off.clear();
    expect(r.store.has(OFFLINE_KEY)).toBe(false);
  });

  it('restore() marks every snapshot stale, derives view-only grants and shows the layout', () => {
    const r = rig();
    r.off.start();
    r.runTimers();
    const target = rig({ storage: r.deps.storage, stream: { snapshots: {}, on: () => () => {} } });
    expect(target.off.restore()).toBe(true);
    expect(target.off.restored).toBe(true);
    expect(target.deps.stream.snapshots.i1?.stale).toBe(true);
    expect(target.deps.session.status).toBe('signedIn');
    const me = target.deps.session.me as { grants: Record<string, string>; csrf: string; role: string };
    expect(me.grants).toEqual({ clock: 'view' });
    expect(me.csrf).toBe('');
    expect(me.role).toBe('member');
    const restore = target.deps.pages.restore as ReturnType<typeof vi.fn>;
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('nothing stored, or junk stored: restore() is false', () => {
    const r = rig();
    expect(r.off.restore()).toBe(false);
    r.store.set(OFFLINE_KEY, '{nope');
    expect(r.off.restore()).toBe(false);
    r.store.set(OFFLINE_KEY, JSON.stringify({ v: 2 }));
    expect(r.off.restore()).toBe(false);
  });

  it('retries the session quietly and leaves the restored state when it works', async () => {
    const r0 = rig();
    r0.off.start();
    r0.runTimers();
    let ok = false;
    const sessionDeps = {
      me: null as unknown,
      status: 'loading' as 'loading' | 'signedOut' | 'signedIn',
      refresh: () => (ok ? Promise.resolve() : Promise.reject(new Error('offline'))),
    };
    const r = rig({ storage: r0.deps.storage, session: sessionDeps });
    r.off.restore();
    await r.off.tryReconnect();
    expect(r.off.restored).toBe(true); // still offline: nothing changes, no error
    ok = true;
    await r.off.tryReconnect();
    expect(r.off.restored).toBe(false);
  });
});

function signedIn() {
  session.me = makeMe({ name: 'Alice' });
  session.status = 'signedIn';
}

describe('app start without a server', () => {
  afterEach(() => {
    offline.clear();
    stream.disconnect();
    sessionStorage.clear();
  });

  it('renders the stored pages with stale snapshots and the offline banner, and keeps retrying the session', async () => {
    const stored: StoredState = {
      v: 1,
      pages: [page('p1', [inst('i1')], { name: 'Home', ownerId: 'u1' })],
      snapshots: { i1: snap('i1', { temp: 21 }) },
    };
    sessionStorage.setItem(OFFLINE_KEY, JSON.stringify(stored));
    server.use(http.get('/api/me', () => HttpResponse.error()));
    render(App);
    expect(await screen.findByText('Offline — showing last data')).toBeTruthy();
    expect(await screen.findByRole('tab', { name: 'Home' })).toBeTruthy();
    expect(offline.restored).toBe(true);
    expect(stream.snapshots.i1?.stale).toBe(true);
    expect(pages.list).toHaveLength(1);
    expect(screen.queryByLabelText('Name')).toBeNull(); // not the sign-in screen
  });

  it('without a stored state the sign-in screen shows', async () => {
    server.use(http.get('/api/me', () => HttpResponse.error()));
    render(App);
    expect(await screen.findByLabelText('Name')).toBeTruthy();
    await waitFor(() => expect(session.status).toBe('signedOut'));
  });
});
