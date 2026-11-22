import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpdater, type ContainerLike, type RegistrationLike, type WorkerLike } from '../../src/lib/update.svelte.js';
import { routeKind, shouldHandle } from '../../src/sw-routing.js';
import Banners from '../../src/shell/Banners.svelte';

const ORIGIN = 'https://dash.example';
const nav = { mode: 'navigate', method: 'GET' };
const sub = { mode: 'cors', method: 'GET' };
const u = (path: string, origin = ORIGIN): URL => new URL(path, origin);

describe('service worker routing', () => {
  it('never handles /api, /dav and /.well-known', () => {
    for (const path of ['/api/me', '/api/m/clock/x?y=1', '/dav/', '/dav/calendars/a', '/.well-known/caldav', '/api']) {
      expect(shouldHandle(u(path), sub, ORIGIN), path).toBe(false);
      expect(shouldHandle(u(path), nav, ORIGIN), `${path} (navigation)`).toBe(false);
    }
    // a path that merely starts with the same letters is a normal path
    expect(shouldHandle(u('/apiary'), nav, ORIGIN)).toBe(true);
  });

  it('navigations fall back to the shell, assets are handled, the rest is not', () => {
    expect(routeKind(u('/'), nav, ORIGIN)).toBe('navigation');
    expect(routeKind(u('/p/abc?d=x'), nav, ORIGIN)).toBe('navigation');
    expect(routeKind(u('/assets/Clock-abc.js'), sub, ORIGIN)).toBe('asset');
    expect(routeKind(u('/assets/bg-abc.webp'), sub, ORIGIN)).toBe('asset');
    expect(routeKind(u('/other.json'), sub, ORIGIN)).toBeNull();
    expect(routeKind(u('/assets/x.js'), { mode: 'cors', method: 'POST' }, ORIGIN)).toBeNull();
    expect(routeKind(u('/assets/x.js', 'https://evil.example'), sub, ORIGIN)).toBeNull();
  });
});

describe('service worker', () => {
  it('sw never caches /api', async () => {
    vi.resetModules();
    const routes: Array<{ match: (c: { url: URL; request: { mode: string; method: string } }) => boolean; handler: unknown }> = [];
    const strategies: unknown[] = [];
    vi.doMock('workbox-routing', () => ({
      registerRoute: (match: never, handler: unknown) => void routes.push({ match, handler }),
    }));
    vi.doMock('workbox-precaching', () => ({
      precacheAndRoute: vi.fn(),
      cleanupOutdatedCaches: vi.fn(),
      createHandlerBoundToURL: (url: string) => ({ shell: url }),
    }));
    vi.doMock('workbox-strategies', () => ({
      StaleWhileRevalidate: class {
        constructor(public options: unknown) {
          strategies.push(this);
        }
      },
    }));
    (self as unknown as { __WB_MANIFEST: unknown[] }).__WB_MANIFEST = [];
    await import('../../src/sw.js');

    // exactly two routes (shell fallback, assets), neither matches the server prefixes
    expect(routes).toHaveLength(2);
    const origin = self.location.origin;
    for (const path of ['/api/me', '/api/m/clock/a', '/dav/', '/.well-known/caldav']) {
      for (const request of [nav, sub]) {
        const url = new URL(path, origin);
        expect(routes.some((r) => r.match({ url, request })), `${path} ${request.mode}`).toBe(false);
      }
    }
    // navigations use the cached shell, assets use stale-while-revalidate
    const shell = routes.find((r) => r.match({ url: new URL('/', origin), request: nav }));
    expect(shell?.handler).toEqual({ shell: '/index.html' });
    const asset = routes.find((r) => r.match({ url: new URL('/assets/a.js', origin), request: sub }));
    expect(strategies).toContain(asset?.handler);
    vi.doUnmock('workbox-routing');
    vi.doUnmock('workbox-precaching');
    vi.doUnmock('workbox-strategies');
  });
});

describe('offline banner', () => {
  it('offline banner appears when stream status is offline', () => {
    render(Banners, { props: { status: 'offline', update: { available: false, apply: () => {} } } });
    expect(screen.getByText('Offline — showing last data')).toBeTruthy();
  });

  it('no banner while live', () => {
    render(Banners, { props: { status: 'live', update: { available: false, apply: () => {} } } });
    expect(screen.queryByText('Offline — showing last data')).toBeNull();
  });
});

function fakeWorker(state = 'installed'): WorkerLike & { posted: unknown[]; fire(): void } {
  const handlers: Array<() => void> = [];
  return {
    state,
    posted: [],
    postMessage(m) {
      this.posted.push(m);
    },
    addEventListener: (_t, fn) => void handlers.push(fn),
    fire: () => handlers.forEach((h) => h()),
  };
}

describe('update prompt', () => {
  function rig(opts: { controller: boolean; waiting: WorkerLike | null }) {
    const reload = vi.fn();
    const controllerHandlers: Array<() => void> = [];
    const updateFound: Array<() => void> = [];
    const reg: RegistrationLike & { installing: WorkerLike | null } = {
      waiting: opts.waiting,
      installing: null,
      addEventListener: (_t, fn) => void updateFound.push(fn),
    };
    const container: ContainerLike = {
      controller: opts.controller ? {} : null,
      register: () => Promise.resolve(reg),
      addEventListener: (_t, fn) => void controllerHandlers.push(fn),
    };
    const updater = createUpdater({ container, reload });
    return { updater, reload, reg, updateFound, controllerHandlers };
  }

  beforeEach(() => vi.useRealTimers());

  it('shows "Update available — reload" when a worker is waiting and posts skip-waiting on click, then reloads once', async () => {
    const waiting = fakeWorker();
    const r = rig({ controller: true, waiting });
    await r.updater.register();
    expect(r.updater.available).toBe(true);
    const user = userEvent.setup();
    render(Banners, { props: { status: 'live', update: r.updater } });
    expect(screen.getByText('Update available — reload')).toBeTruthy();
    expect(waiting.posted).toEqual([]); // nothing is activated by itself
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(waiting.posted).toEqual([{ type: 'SKIP_WAITING' }]);
    expect(r.reload).not.toHaveBeenCalled();
    r.controllerHandlers.forEach((h) => h());
    r.controllerHandlers.forEach((h) => h());
    expect(r.reload).toHaveBeenCalledTimes(1);
  });

  it('a newly installed worker becomes the waiting one; the very first install is not an update', async () => {
    const first = rig({ controller: false, waiting: null });
    await first.updater.register();
    const w = fakeWorker('installing');
    first.reg.installing = w;
    first.updateFound.forEach((f) => f());
    w.state = 'installed';
    w.fire();
    expect(first.updater.available).toBe(false);

    const second = rig({ controller: true, waiting: null });
    await second.updater.register();
    const w2 = fakeWorker('installing');
    second.reg.installing = w2;
    second.updateFound.forEach((f) => f());
    w2.state = 'installed';
    w2.fire();
    expect(second.updater.available).toBe(true);
  });

  it('a controller change nobody asked for does not reload', async () => {
    const r = rig({ controller: true, waiting: null });
    await r.updater.register();
    r.controllerHandlers.forEach((h) => h());
    expect(r.reload).not.toHaveBeenCalled();
  });
});
