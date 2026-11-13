import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { http, HttpResponse } from 'msw';
import { server } from '../setup.js';
import { api } from '../../src/lib/api.js';
import { createPages, pages, type PagesDeps } from '../../src/lib/pages.svelte.js';
import PageTabs from '../../src/shell/PageTabs.svelte';
import Pages from '../../src/shell/Pages.svelte';
import { stream } from '../../src/lib/stream.svelte.js';
import { signIn } from './helpers.js';
import { FakeGrid, inst, page, registry, type PageT } from './pageFixtures.js';

/** Manual scheduler: deterministic debounce without touching MSW's timers. */
function makeTimers() {
  let now = 0;
  let seq = 0;
  const q = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeout: (fn: () => void, ms: number) => {
      const h = ++seq;
      q.set(h, { at: now + ms, fn });
      return h;
    },
    clearTimeout: (h: unknown) => void q.delete(h as number),
    advance(ms: number) {
      now += ms;
      for (const [h, t] of [...q].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && q.delete(h)) t.fn();
      }
    },
  };
}

function makeEnv(initialUrl = '/') {
  const url = new URL(initialUrl, 'http://localhost');
  const loc = { pathname: url.pathname, search: url.search, hash: url.hash };
  const set = (u: string) => {
    const n = new URL(u, 'http://localhost');
    Object.assign(loc, { pathname: n.pathname, search: n.search, hash: n.hash });
  };
  const history = {
    pushState: vi.fn((_s: unknown, _t: string, u?: string | URL | null) => set(String(u))),
    replaceState: vi.fn((_s: unknown, _t: string, u?: string | URL | null) => set(String(u))),
  };
  let pop: (() => void) | null = null;
  const win = {
    addEventListener: (_t: 'popstate', fn: () => void) => void (pop = fn),
    removeEventListener: () => void (pop = null),
  };
  const layoutHandlers: ((e: { type: 'layout'; pageId: string }) => void)[] = [];
  const fakeStream = {
    setInstanceModules: vi.fn(),
    on: (_t: 'layout', fn: (e: { type: 'layout'; pageId: string }) => void) => {
      layoutHandlers.push(fn);
      return () => {};
    },
  };
  const timers = makeTimers();
  const deps: PagesDeps = { api, stream: fakeStream, ...timers, history, location: loc, window: win };
  return {
    deps,
    history,
    loc,
    timers,
    fakeStream,
    popTo: (u: string) => {
      set(u);
      pop?.();
    },
    emitLayout: (pageId: string) => layoutHandlers.forEach((h) => h({ type: 'layout', pageId })),
    store: createPages(deps),
  };
}

function servePages(list: () => PageT[]) {
  const gets = { n: 0 };
  server.use(
    http.get('/api/pages', () => {
      gets.n++;
      return HttpResponse.json(list());
    }),
  );
  return gets;
}

function serveLayoutPut() {
  const puts: { id: string; body: { items: { id: string; layout: unknown; mobileOrder: number }[] } }[] = [];
  server.use(
    http.put('/api/pages/:id/layout', async ({ params, request }) => {
      puts.push({ id: String(params.id), body: (await request.json()) as never });
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return puts;
}

const lay = (x: number) => ({ x, y: 0, w: 2, h: 2 });
const three = () => [page('p1', [inst('a')]), page('p2', [inst('b')]), page('p3', [])];

describe('pages store', () => {
  it('loads pages, selects the first and replaces the URL', async () => {
    servePages(three);
    const e = makeEnv('/');
    await e.store.load();
    expect(e.store.status).toBe('ready');
    expect(e.store.list.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(e.store.current?.id).toBe('p1');
    expect(e.history.replaceState).toHaveBeenCalledWith(null, '', '/p/p1');
  });

  it('unknown /p/<id> falls back to the first page and replaces the URL, keeping the query', async () => {
    servePages(three);
    const e = makeEnv('/p/nope?d=abc');
    await e.store.load();
    expect(e.store.currentId).toBe('p1');
    expect(e.history.replaceState).toHaveBeenCalledWith(null, '', '/p/p1?d=abc');
  });

  it('a valid /p/<id> is kept without touching the URL', async () => {
    servePages(three);
    const e = makeEnv('/p/p2');
    await e.store.load();
    expect(e.store.currentId).toBe('p2');
    expect(e.history.replaceState).not.toHaveBeenCalled();
  });

  it('select pushes the URL and preserves other query parameters', async () => {
    servePages(three);
    const e = makeEnv('/p/p1?d=abc');
    await e.store.load();
    e.store.select('p2');
    expect(e.history.pushState).toHaveBeenCalledWith(null, '', '/p/p2?d=abc');
    expect(e.store.currentId).toBe('p2');
    e.store.select('missing');
    expect(e.store.currentId).toBe('p2');
  });

  it('next and prev stop at the ends', async () => {
    servePages(three);
    const e = makeEnv('/p/p1');
    await e.store.load();
    e.store.prev();
    expect(e.store.currentId).toBe('p1');
    e.store.next();
    e.store.next();
    e.store.next();
    expect(e.store.currentId).toBe('p3');
  });

  it('popstate changes the page', async () => {
    servePages(three);
    const e = makeEnv('/p/p1');
    await e.store.load();
    e.popTo('/p/p3');
    expect(e.store.currentId).toBe('p3');
    e.popTo('/p/ghost');
    expect(e.store.currentId).toBe('p1');
  });

  it('goes to the error state and recovers on retry', async () => {
    server.use(http.get('/api/pages', () => new HttpResponse(null, { status: 500 })));
    const e = makeEnv('/');
    await e.store.load();
    expect(e.store.status).toBe('error');
    servePages(three);
    await e.store.load();
    expect(e.store.status).toBe('ready');
  });

  it('stream.setInstanceModules is called after load with the right map', async () => {
    servePages(() => [page('p1', [inst('a', { moduleId: 'clock' })]), page('p2', [inst('b', { moduleId: 'weather' })])]);
    const e = makeEnv('/');
    await e.store.load();
    expect(e.fakeStream.setInstanceModules).toHaveBeenLastCalledWith({ a: 'clock', b: 'weather' });
  });

  it('layout PUT is debounced to one call', async () => {
    servePages(three);
    const puts = serveLayoutPut();
    const e = makeEnv('/');
    await e.store.load();
    const item = (x: number) => [{ id: 'a', layout: lay(x), mobileOrder: 0 }];
    e.store.saveLayout('p1', item(1));
    e.timers.advance(400);
    e.store.saveLayout('p1', item(2));
    e.timers.advance(400);
    e.store.saveLayout('p1', item(3));
    expect(puts).toHaveLength(0);
    e.timers.advance(500);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ id: 'p1', body: { items: item(3) } });
    expect(e.store.list[0]?.instances[0]?.layout).toEqual(lay(3));
  });

  it('layout saves for two pages do not cancel each other', async () => {
    servePages(three);
    const puts = serveLayoutPut();
    const e = makeEnv('/');
    await e.store.load();
    e.store.saveLayout('p1', [{ id: 'a', layout: lay(1), mobileOrder: 0 }]);
    e.timers.advance(200);
    e.store.saveLayout('p2', [{ id: 'b', layout: lay(4), mobileOrder: 0 }]);
    e.timers.advance(1000);
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(puts.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
  });

  it('a layout stream event refetches that page', async () => {
    let list = three();
    const gets = servePages(() => list);
    const e = makeEnv('/');
    await e.store.load();
    list = [page('p1', [inst('a', { layout: lay(7) })]), ...list.slice(1)];
    e.emitLayout('p1');
    await waitFor(() => expect(e.store.list[0]?.instances[0]?.layout).toEqual(lay(7)));
    expect(gets.n).toBe(2);
  });

  it('a layout stream event is deferred while editing, then refetched when editing ends', async () => {
    let list = three();
    const gets = servePages(() => list);
    const e = makeEnv('/');
    await e.store.load();
    e.store.setEditing(true);
    list = [page('p1', [inst('a', { layout: lay(7) })]), ...list.slice(1)];
    e.emitLayout('p1');
    await Promise.resolve();
    expect(gets.n).toBe(1);
    e.store.setEditing(false);
    await waitFor(() => expect(e.store.list[0]?.instances[0]?.layout).toEqual(lay(7)));
    expect(gets.n).toBe(2);
  });

  it('a layout stream event is deferred while a save is pending', async () => {
    const list = three();
    const gets = servePages(() => list);
    serveLayoutPut();
    const e = makeEnv('/');
    await e.store.load();
    e.store.saveLayout('p1', [{ id: 'a', layout: lay(2), mobileOrder: 0 }]);
    e.emitLayout('p1');
    await Promise.resolve();
    expect(gets.n).toBe(1);
    e.timers.advance(500);
    await waitFor(() => expect(gets.n).toBe(2)); // refetched after the save settled
  });
});

describe('Pages and PageTabs components', () => {
  const narrow = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  const wide = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  const noObserver = () => ({ observe: () => {}, disconnect: () => {} });

  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });
  afterEach(() => {
    pages.clear();
    vi.restoreAllMocks();
  });

  async function loaded(list: PageT[], url = '/') {
    window.history.replaceState(null, '', url);
    servePages(() => list);
    signIn();
    await pages.load();
  }

  const mobileProps = { modules: registry, matchMedia: narrow, observerFactory: noObserver };

  function pointer(el: Element, type: 'pointerdown' | 'pointerup', x: number, y: number) {
    // jsdom has no PointerEvent: a MouseEvent with the pointer type carries clientX/clientY.
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
  }
  async function swipe(el: Element, dx: number, dy = 0) {
    pointer(el, 'pointerdown', 200, 200);
    pointer(el, 'pointerup', 200 + dx, 200 + dy);
    await Promise.resolve();
  }

  it('shows the loading state, then the page', async () => {
    servePages(three);
    signIn();
    const { findByText, getByRole } = render(Pages, mobileProps);
    expect(getByRole('status').textContent).toContain('Loading');
    void pages.load();
    expect(await findByText('Clock')).toBeTruthy();
  });

  it('shows an error with retry', async () => {
    server.use(http.get('/api/pages', () => new HttpResponse(null, { status: 500 })));
    signIn();
    const { findByRole } = render(Pages, mobileProps);
    await pages.load();
    const retry = await findByRole('button', { name: 'Retry' });
    servePages(three);
    await fireEvent.click(retry);
    await waitFor(() => expect(pages.status).toBe('ready'));
  });

  it('shows an empty-page state', async () => {
    await loaded([page('p1', [])]);
    const { getByText } = render(Pages, mobileProps);
    expect(getByText('This page is empty.')).toBeTruthy();
  });

  it('renders one tile frame per instance', async () => {
    await loaded([page('p1', [inst('a'), inst('b'), inst('c')])]);
    const { container } = render(Pages, mobileProps);
    expect(container.querySelectorAll('[data-instance-id]')).toHaveLength(3);
  });

  it('mobile order follows mobileOrder', async () => {
    await loaded([
      page('p1', [
        inst('a', { mobileOrder: 2 }),
        inst('b', { mobileOrder: 0, layout: { x: 6, y: 5, w: 3, h: 2 } }),
        inst('c', { mobileOrder: 1 }),
      ]),
    ]);
    const { container } = render(Pages, mobileProps);
    const ids = [...container.querySelectorAll('[data-instance-id]')].map((n) => n.getAttribute('data-instance-id'));
    expect(ids).toEqual(['b', 'c', 'a']);
  });

  it('chooses the grid on wide viewports and the stack on narrow ones', async () => {
    await loaded([page('p1', [inst('a')])]);
    const g = new FakeGrid();
    const w = render(Pages, { ...mobileProps, matchMedia: wide, gridFactory: () => g });
    await waitFor(() => expect(w.container.querySelector('.grid-stack')).toBeTruthy());
    w.unmount();
    const n = render(Pages, mobileProps);
    expect(n.container.querySelector('.grid-stack')).toBeNull();
    expect(n.container.querySelector('.stack')).toBeTruthy();
  });

  it('swipe left goes to next page', async () => {
    await loaded(three(), '/p/p1');
    const { container } = render(Pages, mobileProps);
    await swipe(container.querySelector('.stack')!, -90);
    expect(pages.currentId).toBe('p2');
  });

  it('swipe right goes to the previous page and does nothing on the first page', async () => {
    await loaded(three(), '/p/p2');
    const { container } = render(Pages, mobileProps);
    await swipe(container.querySelector('.stack')!, 90);
    expect(pages.currentId).toBe('p1');
    await swipe(container.querySelector('.stack')!, 90);
    expect(pages.currentId).toBe('p1');
  });

  it('a mostly vertical drag does not change page', async () => {
    await loaded(three(), '/p/p1');
    const { container } = render(Pages, mobileProps);
    await swipe(container.querySelector('.stack')!, -80, 120);
    await swipe(container.querySelector('.stack')!, -40, 0);
    expect(pages.currentId).toBe('p1');
  });

  it('a swipe starting in data-no-swipe or an input is ignored', async () => {
    await loaded(three(), '/p/p1');
    const { container } = render(Pages, mobileProps);
    const stack = container.querySelector('.stack')!;
    const guarded = document.createElement('div');
    guarded.setAttribute('data-no-swipe', '');
    const inner = document.createElement('span');
    guarded.append(inner);
    const input = document.createElement('input');
    stack.append(guarded, input);
    await swipe(inner, -90);
    await swipe(input, -90);
    expect(pages.currentId).toBe('p1');
  });

  it('reports on-screen tiles to the stream', async () => {
    await loaded([page('p1', [inst('a'), inst('b')])]);
    const setVisible = vi.spyOn(stream, 'setVisible');
    let cb: IntersectionObserverCallback = () => {};
    const observed: Element[] = [];
    render(Pages, {
      ...mobileProps,
      observerFactory: (c: IntersectionObserverCallback) => {
        cb = c;
        return { observe: (el: Element) => void observed.push(el), disconnect: () => {} };
      },
    });
    expect(observed).toHaveLength(2);
    cb([{ target: observed[0]!, isIntersecting: true }, { target: observed[1]!, isIntersecting: false }] as never, {} as never);
    expect(setVisible).toHaveBeenLastCalledWith(['a']);
  });

  it('tabs: roles, aria-selected, arrow keys and shared marker', async () => {
    await loaded([page('p1'), page('p2', [], { ownerId: 'u2', shared: true }), page('p3')], '/p/p1');
    const { getAllByRole, getByText } = render(PageTabs);
    const tabs = getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(getAllByRole('tablist')).toHaveLength(1);
    expect(getByText('shared')).toBeTruthy();
    await fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(pages.currentId).toBe('p2');
    await waitFor(() => expect(document.activeElement).toBe(tabs[1]));
    await fireEvent.keyDown(tabs[1]!, { key: 'End' });
    expect(pages.currentId).toBe('p3');
    await fireEvent.keyDown(tabs[2]!, { key: 'ArrowRight' });
    expect(pages.currentId).toBe('p3');
    await fireEvent.click(tabs[0]!);
    expect(pages.currentId).toBe('p1');
  });
});
