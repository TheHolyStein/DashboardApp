import type { Intensity, ThemeManifest } from '@dash/contract';
import { render } from '@testing-library/svelte';
import { flushSync, type Component } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BackgroundHost, { resetFailedScenes } from '../../src/theme/BackgroundHost.svelte';
import { createSceneEnv } from '../../src/theme/env.svelte.js';
import { setUserIntensityOverride } from '../../src/theme/intensity.js';
import SceneA from './fixtures/Scene_a.svelte';
import SceneB from './fixtures/Scene_b.svelte';
import SceneC from './fixtures/Scene_c.svelte';
import SceneThrows from './fixtures/SceneThrows.svelte';
import { makeHarness, makeTheme } from './fixtures/harness.svelte.js';

type Loader = ThemeManifest['backgrounds'][number]['component'];
const comp = (c: unknown): Loader => (() => Promise.resolve({ default: c as Component<never> })) as unknown as Loader;

function scenes(spies: Record<string, ReturnType<typeof vi.fn>>, loaders: Record<string, Loader>) {
  return Object.keys(loaders).map((id) => {
    const spy = vi.fn(loaders[id]);
    spies[id] = spy;
    return { id, name: id, component: spy, staticImage: `${id}.webp` };
  });
}

async function setup(opts: { loaders?: Record<string, Loader>; override?: Intensity | null; now?: string; tz?: string } = {}) {
  const spies: Record<string, ReturnType<typeof vi.fn>> = {};
  const loaders = opts.loaders ?? { a: comp(SceneA), b: comp(SceneB), c: comp(SceneC) };
  const manifest: ThemeManifest = { ...makeTheme('scenic'), backgrounds: scenes(spies, loaders) };
  const h = makeHarness({ themes: { scenic: () => Promise.resolve({ default: manifest }) } });
  await h.engine.set('scenic');
  h.flush();

  setUserIntensityOverride(opts.override ?? null);
  let nowIso = opts.now ?? '2026-11-14T12:00:00Z';
  let tz = opts.tz ?? 'UTC';
  const docListeners = new Set<() => void>();
  const doc = {
    hidden: false,
    addEventListener: (_: string, fn: () => void) => void docListeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => void docListeners.delete(fn),
  };
  const env = createSceneEnv({ now: () => new Date(nowIso), sun: () => null, setInterval: () => 0, clearInterval: () => {}, document: undefined });
  const raf = { requested: 0, cancelled: 0 };
  const deps = {
    engine: h.engine,
    env,
    document: doc,
    timeZone: () => tz,
    assetUrl: (themeId: string, path: string) => Promise.resolve(`/assets/${themeId}/${path}`),
    governor: {
      matchMedia: undefined,
      connection: undefined,
      getBattery: undefined,
      requestAnimationFrame: () => ++raf.requested,
      cancelAnimationFrame: () => void raf.cancelled++,
      now: () => 0,
    },
  };
  const view = render(BackgroundHost, { props: { background: null as string | null, deps } });
  return {
    h,
    spies,
    view,
    raf,
    doc,
    env,
    setHidden(hidden: boolean) {
      doc.hidden = hidden;
      docListeners.forEach((fn) => fn());
      flushSync();
    },
    setNow(iso: string) {
      nowIso = iso;
      env.start(); // re-reads the clock
      env.stop();
      flushSync();
    },
    setTz(z: string) {
      tz = z;
    },
    sceneIds: () => [...document.querySelectorAll('[data-scene]')].map((e) => e.getAttribute('data-scene')),
    image: () => document.querySelector<HTMLImageElement>('img.db-background-image'),
  };
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-call -- eslint cannot resolve a .svelte module export; svelte-check types it
beforeEach(() => resetFailedScenes());
afterEach(() => {
  setUserIntensityOverride(null);
  vi.restoreAllMocks();
});

describe('BackgroundHost', () => {
  it('static does not import the scene component', async () => {
    const t = await setup({ override: 'static' });
    await vi.waitFor(() => expect(t.image()?.getAttribute('src')).toBe('/assets/scenic/a.webp'));
    expect(t.h.engine.intensity).toBe('static');
    expect(t.spies['a']).not.toHaveBeenCalled();
    expect(t.sceneIds()).toEqual([]);
  });

  it('has the required layer attributes', async () => {
    const t = await setup({ override: 'static' });
    const layer = document.querySelector('.db-background')!;
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    t.view.unmount();
  });

  it('shows the static image until the scene has loaded, then only the scene with its props', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = await setup({ loaders: { a: () => gate.then(() => ({ default: SceneA as never })) } });
    await vi.waitFor(() => expect(t.image()).not.toBeNull());
    expect(t.sceneIds()).toEqual([]);
    release();
    await vi.waitFor(() => expect(t.sceneIds()).toEqual(['a']));
    expect(t.image()).toBeNull();
    const el = document.querySelector('[data-scene="a"]')!;
    expect(el.getAttribute('data-intensity')).toBe('full');
    expect(el.getAttribute('data-mode')).toBe(t.h.engine.mode);
  });

  it('a failed scene import keeps the static image and logs once', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await setup({ loaders: { a: () => Promise.reject(new Error('chunk missing')) } });
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(t.image()).not.toBeNull());
    expect(t.sceneIds()).toEqual([]);
    t.setHidden(true);
    t.setHidden(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(error).toHaveBeenCalledTimes(1);
    expect(t.spies['a']).toHaveBeenCalledTimes(1); // no retry loop
  });

  it('a throwing scene falls back to the static image for the session', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const t = await setup({ loaders: { boom: comp(SceneThrows) } });
    await vi.waitFor(() => expect(t.image()).not.toBeNull());
    expect(t.sceneIds()).toEqual([]);
    expect(error).toHaveBeenCalled();
    t.setHidden(true);
    t.setHidden(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(t.sceneIds()).toEqual([]);
    expect(t.spies['boom']).toHaveBeenCalledTimes(1);
  });

  it('hidden unmounts the scene and visible remounts it', async () => {
    const t = await setup();
    await vi.waitFor(() => expect(t.sceneIds()).toEqual(['a']));
    t.setHidden(true);
    await vi.waitFor(() => expect(t.sceneIds()).toEqual([]));
    expect(t.image()).not.toBeNull();
    t.setHidden(false);
    await vi.waitFor(() => expect(t.sceneIds()).toEqual(['a']));
  });

  it('switching page background swaps scenes with at most one mounted', async () => {
    const t = await setup();
    let max = 0;
    const observer = new MutationObserver(() => {
      max = Math.max(max, t.sceneIds().length);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    await vi.waitFor(() => expect(t.sceneIds()).toEqual(['a']));
    await t.view.rerender({ background: 'b' });
    await vi.waitFor(() => expect(t.sceneIds()).toEqual(['b']));
    await t.view.rerender({ background: 'c' });
    await vi.waitFor(() => expect(t.sceneIds()).toEqual(['c']));
    await t.view.rerender({ background: 'nope' }); // unknown → first
    await vi.waitFor(() => expect(t.sceneIds()).toEqual(['a']));
    observer.disconnect();
    expect(max).toBeLessThanOrEqual(1);
  });

  it('intensity changes never leave two scenes mounted', async () => {
    const t = await setup();
    await vi.waitFor(() => expect(t.sceneIds()).toEqual(['a']));
    setUserIntensityOverride('static');
    flushSync();
    await vi.waitFor(() => expect(t.sceneIds()).toEqual([]));
    setUserIntensityOverride('calm');
    await vi.waitFor(() => expect(t.sceneIds()).toEqual(['a']));
    expect(document.querySelector('[data-scene="a"]')!.getAttribute('data-intensity')).toBe('calm');
  });

  it('rotate picks by day index', async () => {
    const t = await setup({ now: '2026-11-14T12:00:00Z' });
    await t.view.rerender({ background: 'rotate' });
    const day = Math.floor(Date.UTC(2026, 10, 14) / 86_400_000);
    const ids = ['a', 'b', 'c'];
    await vi.waitFor(() => expect(t.sceneIds()).toEqual([ids[day % 3]]));
  });

  it('rotate is stable within a day and uses the user time zone at the date boundary', async () => {
    const t = await setup({ now: '2026-11-14T00:30:00Z' });
    await t.view.rerender({ background: 'rotate' });
    const day = Math.floor(Date.UTC(2026, 10, 14) / 86_400_000);
    const ids = ['a', 'b', 'c'];
    await vi.waitFor(() => expect(t.sceneIds()).toEqual([ids[day % 3]]));
    t.setNow('2026-11-14T23:59:00Z');
    await new Promise((r) => setTimeout(r, 5));
    expect(t.sceneIds()).toEqual([ids[day % 3]]); // same UTC day
    t.setNow('2026-11-15T00:01:00Z');
    await vi.waitFor(() => expect(t.sceneIds()).toEqual([ids[(day + 1) % 3]]));
    // 23:30 UTC on the 14th is already the 15th in Auckland (UTC+13)
    t.setTz('Pacific/Auckland');
    t.setNow('2026-11-14T23:30:00Z');
    await vi.waitFor(() => expect(t.sceneIds()).toEqual([ids[(day + 1) % 3]]));
    t.setTz('America/Los_Angeles'); // 15:30 on the 14th
    t.setNow('2026-11-14T23:31:00Z');
    await vi.waitFor(() => expect(t.sceneIds()).toEqual([ids[day % 3]]));
  });

  it('starts the governor on mount and leaves nothing behind on unmount', async () => {
    const t = await setup();
    await vi.waitFor(() => expect(t.raf.requested).toBe(1));
    t.view.unmount();
    expect(t.raf.cancelled).toBe(1);
  });
});
