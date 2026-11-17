import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stream } from '../../src/lib/stream.svelte.js';
import { detail } from '../../src/lib/detail.svelte.js';
import { pages } from '../../src/lib/pages.svelte.js';
import { createTicker, TICK_MS } from '../../src/lib/ticker.svelte.js';
import { THEME_KEY, type HostRegistry, type ThemeSeam } from '../../src/lib/host.js';
import TileHost from '../../src/shell/TileHost.svelte';
import { control } from '../fixtures/control.js';
import OverrideTile from '../fixtures/OverrideTile.svelte';
import { client, fakeRegistry } from '../fixtures/registry.js';
import GoodTile from '../fixtures/GoodTile.svelte';
import { reactiveSeam } from '../fixtures/themeSeam.svelte.js';
import { session } from '../../src/lib/session.svelte.js';
import { lookupIcon } from '../../src/lib/host.js';
import { makeMe, signIn } from './helpers.js';
import { inst, page } from './pageFixtures.js';
import ClickTile from './ClickTile.svelte';

const good = inst('i1', { moduleId: 'good', settings: { label: 'hello' }, layout: { x: 0, y: 0, w: 4, h: 3 } });
const boom = inst('i2', { moduleId: 'boom' });
const pg = page('p1', [good, boom]);

/** Swaps the `good` module for a tile with selectable text, a label and a button (selection, drag and label cases). */
function withClickTile(modules: HostRegistry): HostRegistry {
  const inner = modules.good!;
  return { ...modules, good: { ...inner, load: () => Promise.resolve({ default: client('good', ClickTile as never) }) } };
}

function renderHost(instance: typeof good, modules: HostRegistry, theme?: ThemeSeam) {
  return render(TileHost, {
    props: { instance, page: pg, modules },
    ...(theme ? { context: new Map<string, unknown>([[THEME_KEY, theme]]) } : {}),
  });
}

beforeEach(() => {
  signIn({ grants: { good: 'view', boom: 'view' } });
  control.throwTile = false;
  control.throwDetail = false;
});
afterEach(() => {
  for (const k of Object.keys(stream.snapshots)) delete stream.snapshots[k];
});

describe('TileHost', () => {
  it('tile that throws shows failure placeholder and others still render', async () => {
    const { modules } = fakeRegistry();
    control.throwTile = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderHost(boom, modules);
      renderHost(good, modules);
      expect(await screen.findByRole('alert')).toBeTruthy();
      expect(screen.getByText('This module failed.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
      expect(await screen.findByTestId('good')).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('retry re-mounts a tile that threw', async () => {
    const { modules } = fakeRegistry();
    control.throwTile = true;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      renderHost(boom, modules);
      await screen.findByRole('alert');
      control.throwTile = false;
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByTestId('recovered')).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('a failed load() shows the failure tile and retry loads again', async () => {
    const { modules, loads, failLoad } = fakeRegistry();
    failLoad.add('good');
    renderHost(good, modules);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(loads.good).toBe(1);
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('good')).toBeTruthy();
    expect(loads.good).toBe(2);
  });

  it('shows a skeleton while loading', async () => {
    const { modules } = fakeRegistry();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const inner = modules.good!;
    modules.good = { ...inner, load: async () => (await gate, inner.load!()) };
    renderHost(good, modules);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeTruthy();
    release();
    expect(await screen.findByTestId('good')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
  });

  it('a module without a client loader shows the failure tile', async () => {
    const { modules } = fakeRegistry();
    modules.good = { manifest: modules.good!.manifest };
    renderHost(good, modules);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('stale flag shows stale badge', async () => {
    const { modules } = fakeRegistry();
    stream.snapshots.i1 = { instanceId: 'i1', data: { text: 'old' }, updatedAt: '2026-01-01T00:00:00Z', stale: true };
    renderHost(good, modules);
    expect(await screen.findByText('Stale')).toBeTruthy();
    expect((await screen.findByTestId('text')).textContent).toBe('old');
  });

  it('freshness footer shows the relative time of the snapshot', async () => {
    const { modules } = fakeRegistry();
    stream.snapshots.i1 = { instanceId: 'i1', data: {}, updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(), stale: false };
    renderHost(good, modules);
    expect(await screen.findByText('5 min ago')).toBeTruthy();
    expect(screen.queryByText('Stale')).toBeNull();
  });

  it('passes data, settings, size and mode, and shows the manifest title and module icon', async () => {
    const { modules } = fakeRegistry();
    stream.snapshots.i1 = { instanceId: 'i1', data: { text: 'hi' }, updatedAt: null, stale: false };
    renderHost(good, modules, { tileFor: () => Promise.resolve(null), mode: 'night' });
    expect((await screen.findByTestId('text')).textContent).toBe('hi');
    expect(screen.getByTestId('label').textContent).toBe('hello');
    expect(screen.getByTestId('size').textContent).toBe('4x3');
    expect(screen.getByTestId('mode').textContent).toBe('night');
    expect(screen.getByRole('heading', { name: 'Good' })).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-testid="mod-icon"]')).toBeTruthy());
  });

  it('mode defaults to day without a theme', async () => {
    const { modules } = fakeRegistry();
    renderHost(good, modules);
    expect((await screen.findByTestId('mode')).textContent).toBe('day');
  });

  it('theme icons win over module icons', async () => {
    const { modules } = fakeRegistry();
    renderHost(good, modules, {
      tileFor: () => Promise.resolve(null),
      icon: (n) => (n === 'clock' ? '<svg data-testid="theme-icon"></svg>' : undefined),
    });
    await screen.findByTestId('good');
    expect(document.querySelector('[data-testid="theme-icon"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="mod-icon"]')).toBeNull();
  });

  it('override tile used when theme provides one, default otherwise', async () => {
    const { modules } = fakeRegistry();
    const theme: ThemeSeam = { tileFor: (id) => Promise.resolve(id === 'good' ? (OverrideTile as never) : null) };
    const a = renderHost(good, modules, theme);
    expect(await screen.findByTestId('override')).toBeTruthy();
    expect(screen.queryByTestId('good')).toBeNull();
    a.unmount();
    renderHost(boom, modules, theme); // theme returns null for this module: its own tile
    expect(await screen.findByTestId('recovered')).toBeTruthy();
    expect(screen.queryByTestId('override')).toBeNull();
    // and no theme at all
    document.body.innerHTML = '';
    renderHost(good, modules);
    expect(await screen.findByTestId('good')).toBeTruthy();
  });

  it('a failing theme seam falls back to the module tile', async () => {
    const { modules } = fakeRegistry();
    renderHost(good, modules, { tileFor: () => Promise.reject(new Error('nope')) });
    expect(await screen.findByTestId('good')).toBeTruthy();
  });

  it('level passed to the tile follows session.me.grants', async () => {
    const { modules } = fakeRegistry();
    signIn({ grants: { good: 'edit' } });
    const a = renderHost(good, modules);
    expect((await screen.findByTestId('level')).textContent).toBe('edit');
    a.unmount();
    signIn({ grants: { good: 'view' } });
    renderHost(good, modules);
    expect((await within(document.body).findByTestId('level')).textContent).toBe('view');
  });
});

describe('TileHost detail affordance', () => {
  beforeEach(() => {
    detail.sync();
    pages.setEditing(false);
  });
  afterEach(() => {
    pages.setEditing(false);
    window.history.replaceState(null, '', '/');
    detail.sync();
  });

  it('clicking the frame opens the pane for the instance', async () => {
    const { modules } = fakeRegistry();
    renderHost(good, modules);
    await userEvent.click(await screen.findByTestId('plain-area'));
    expect(detail.current).toEqual({ id: 'i1', params: {} });
  });

  it('a click while text is selected inside the tile does not open the pane', async () => {
    const { modules } = fakeRegistry();
    renderHost(good, withClickTile(modules));
    const el = await screen.findByTestId('sel-text');
    const range = document.createRange();
    range.selectNodeContents(el);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    expect(window.getSelection()?.toString()).toBe('Select this sentence');
    try {
      await fireEvent.click(screen.getByTestId('plain-area'));
      expect(detail.current).toBeNull();
    } finally {
      window.getSelection()?.removeAllRanges();
    }
  });

  it('a drag (pointer moved more than 5 px between pointerdown and click) does not open the pane', async () => {
    const { modules } = fakeRegistry();
    renderHost(good, withClickTile(modules));
    const area = await screen.findByTestId('plain-area');
    await fireEvent.pointerDown(area, { clientX: 0, clientY: 0 });
    await fireEvent.click(area, { clientX: 20, clientY: 0 });
    expect(detail.current).toBeNull();
  });

  it('a click within 5 px of the pointerdown position still opens the pane', async () => {
    const { modules } = fakeRegistry();
    renderHost(good, withClickTile(modules));
    const area = await screen.findByTestId('plain-area');
    await fireEvent.pointerDown(area, { clientX: 0, clientY: 0 });
    await fireEvent.click(area, { clientX: 3, clientY: 4 });
    expect(detail.current).toEqual({ id: 'i1', params: {} });
  });

  it('a click on a label inside the tile does not open the pane', async () => {
    const { modules } = fakeRegistry();
    renderHost(good, withClickTile(modules));
    await fireEvent.click(await screen.findByTestId('lbl-text'));
    expect(detail.current).toBeNull();
  });

  it('clicking a button or a [data-no-open] element inside the tile does not open it', async () => {
    const { modules } = fakeRegistry();
    renderHost(good, modules);
    await userEvent.click(await screen.findByTestId('noop'));
    await userEvent.click(screen.getByTestId('no-open'));
    expect(detail.current).toBeNull();
  });

  it('the tile can still open the pane with its own params', async () => {
    const { modules } = fakeRegistry();
    renderHost(good, modules);
    await userEvent.click(await screen.findByRole('button', { name: 'open week' }));
    expect(detail.current).toEqual({ id: 'i1', params: { tab: 'week' } });
  });

  it('edit mode does not open the pane and shows no title button', async () => {
    const { modules } = fakeRegistry();
    renderHost(good, modules);
    await screen.findByTestId('plain-area');
    pages.setEditing(true);
    await userEvent.click(screen.getByTestId('plain-area'));
    expect(detail.current).toBeNull();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Good' })).toBeNull());
  });

  it('the title is a button that opens the pane with Enter and with Space', async () => {
    const { modules } = fakeRegistry();
    renderHost(good, modules);
    const title = await screen.findByRole('button', { name: 'Good' });
    expect(title.getAttribute('aria-haspopup')).toBe('dialog');
    title.focus();
    await userEvent.keyboard('{Enter}');
    expect(detail.current?.id).toBe('i1');
    detail.drop();
    title.focus();
    await userEvent.keyboard(' ');
    expect(detail.current?.id).toBe('i1');
  });

  it('detail: false hides the affordance (no title button, frame click does nothing)', async () => {
    const { modules } = fakeRegistry();
    const inner = modules.good!;
    modules.good = { ...inner, load: () => Promise.resolve({ default: client('good', GoodTile as never, { detail: false }) }) };
    renderHost(good, modules);
    await userEvent.click(await screen.findByTestId('plain-area'));
    expect(detail.current).toBeNull();
    expect(screen.queryByRole('button', { name: 'Good' })).toBeNull();
    expect(document.querySelector('[data-openable]')).toBeNull();
  });
});

describe('TileHost grants', () => {
  for (const [name, grants] of [['none', { good: 'none' }], ['missing', {}]] as const) {
    it(`grant ${name}: module is not loaded, unavailable frame shown, no tile`, async () => {
      const { modules, loads } = fakeRegistry();
      signIn({ grants });
      renderHost(good, modules);
      expect(await screen.findByText('Module unavailable')).toBeTruthy();
      await new Promise((r) => setTimeout(r, 20));
      expect(loads.good ?? 0).toBe(0);
      expect(screen.queryByTestId('good')).toBeNull();
    });
  }

  it('revoking the grant while mounted replaces the tile with the unavailable frame', async () => {
    const { modules } = fakeRegistry();
    renderHost(good, modules);
    expect(await screen.findByTestId('good')).toBeTruthy();
    session.me = makeMe({ grants: { good: 'none' } });
    expect(await screen.findByText('Module unavailable')).toBeTruthy();
    expect(screen.queryByTestId('good')).toBeNull();
  });

  it('granting access while mounted loads the tile', async () => {
    const { modules, loads } = fakeRegistry();
    signIn({ grants: {} });
    renderHost(good, modules);
    await screen.findByText('Module unavailable');
    session.me = makeMe({ grants: { good: 'view' } });
    expect(await screen.findByTestId('good')).toBeTruthy();
    expect(loads.good).toBe(1);
  });

  it('a module icon named constructor does not resolve to a function', () => {
    expect(lookupIcon(undefined, {}, 'constructor')).toBeUndefined();
    expect(lookupIcon(undefined, { clock: '<svg/>' }, 'clock')).toBe('<svg/>');
  });
});

describe('TileHost theme override resolution', () => {
  it('calls tileFor with the tile size', async () => {
    const { modules } = fakeRegistry();
    const t = reactiveSeam(() => Promise.resolve(null));
    renderHost(good, modules, t.seam);
    await screen.findByTestId('good');
    expect(t.calls[0]).toMatchObject({ moduleId: 'good', size: { w: 4, h: 3 } });
  });

  it('switches between override and own tile when the instance layout changes', async () => {
    const { modules } = fakeRegistry();
    const t = reactiveSeam((_id, size) => Promise.resolve(size && size.w >= 4 ? OverrideTile : null));
    const small = inst('i1', { moduleId: 'good', layout: { x: 0, y: 0, w: 2, h: 2 } });
    const { rerender } = renderHost(small, modules, t.seam);
    expect(await screen.findByTestId('good')).toBeTruthy();
    await rerender({ instance: { ...small, layout: { x: 0, y: 0, w: 4, h: 3 } }, page: pg, modules });
    expect(await screen.findByTestId('override')).toBeTruthy();
    await rerender({ instance: small, page: pg, modules });
    expect(await screen.findByTestId('good')).toBeTruthy();
    expect(screen.queryByTestId('override')).toBeNull();
  });

  it('a theme switch re-resolves the override', async () => {
    const { modules } = fakeRegistry();
    const t = reactiveSeam((_id, _size, themeId) => Promise.resolve(themeId === 'b' ? OverrideTile : null));
    renderHost(good, modules, t.seam);
    expect(await screen.findByTestId('good')).toBeTruthy();
    t.setId('b');
    expect(await screen.findByTestId('override')).toBeTruthy();
    t.setId('a');
    expect(await screen.findByTestId('good')).toBeTruthy();
  });

  it('a slower earlier resolve does not overwrite a later one', async () => {
    const { modules } = fakeRegistry();
    const gates: Record<string, (v: unknown) => void> = {};
    const t = reactiveSeam((_id, _size, themeId) => new Promise((r) => (gates[themeId] = r)));
    renderHost(good, modules, t.seam);
    await waitFor(() => expect(gates.a).toBeTruthy());
    t.setId('b');
    await waitFor(() => expect(gates.b).toBeTruthy());
    gates.b!(null);
    expect(await screen.findByTestId('good')).toBeTruthy();
    gates.a!(OverrideTile);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('override')).toBeNull();
    expect(screen.getByTestId('good')).toBeTruthy();
  });

  it('keeps showing the current tile while a new override resolves', async () => {
    const { modules } = fakeRegistry();
    let release: (v: unknown) => void = () => {};
    const t = reactiveSeam((_id, _size, themeId) => (themeId === 'a' ? Promise.resolve(null) : new Promise((r) => (release = r))));
    renderHost(good, modules, t.seam);
    await screen.findByTestId('good');
    t.setId('b');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('good')).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull();
    release(OverrideTile);
    expect(await screen.findByTestId('override')).toBeTruthy();
  });
});

describe('ticker', () => {
  function fake(visible = true) {
    const doc = new EventTarget();
    let t = new Date('2026-11-14T10:00:00Z');
    const state = { visible, timers: 0, cleared: 0, fn: null as null | (() => void) };
    const ticker = createTicker({
      setInterval: (fn) => (state.timers++, (state.fn = fn), state.timers),
      clearInterval: () => (state.cleared++, (state.fn = null)),
      isVisible: () => state.visible,
      document: doc,
      now: () => t,
    });
    return {
      ticker,
      state,
      setTime: (d: Date) => (t = d),
      setVisible: (v: boolean) => ((state.visible = v), doc.dispatchEvent(new Event('visibilitychange'))),
    };
  }

  it('uses a single timer for all subscribers and stops after the last unsubscribes', () => {
    const f = fake();
    const a = f.ticker.subscribe();
    const b = f.ticker.subscribe();
    expect(f.state.timers).toBe(1);
    expect(f.ticker.running).toBe(true);
    a();
    expect(f.ticker.running).toBe(true);
    b();
    expect(f.ticker.running).toBe(false);
  });

  it('advances now on each tick', () => {
    const f = fake();
    f.ticker.subscribe();
    f.setTime(new Date('2026-11-14T10:00:30Z'));
    f.state.fn!();
    expect(f.ticker.now.toISOString()).toBe('2026-11-14T10:00:30.000Z');
    expect(TICK_MS).toBe(30_000);
  });

  it('stops when the document is hidden and restarts, catching up, when visible again', () => {
    const f = fake();
    f.ticker.subscribe();
    f.setVisible(false);
    expect(f.ticker.running).toBe(false);
    f.setTime(new Date('2026-11-14T11:00:00Z'));
    f.setVisible(true);
    expect(f.ticker.running).toBe(true);
    expect(f.ticker.now.toISOString()).toBe('2026-11-14T11:00:00.000Z');
  });

  it('does not start while hidden', () => {
    const f = fake(false);
    f.ticker.subscribe();
    expect(f.ticker.running).toBe(false);
  });
});
