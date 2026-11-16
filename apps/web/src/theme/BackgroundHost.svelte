<script module lang="ts">
  import { SvelteSet } from 'svelte/reactivity';

  /** Scenes (`<theme>/<scene>`) that failed to import or threw; they show their static image for the session. */
  const failedScenes = new SvelteSet<string>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain log-once bookkeeping, not rendered
  const reported = new Set<string>();

  /** Test seam: forget failed scenes. */
  export function resetFailedScenes(): void {
    failedScenes.clear();
    reported.clear();
  }

  /** Whole days since the epoch of the calendar date `now` falls on in `timeZone` (runtime zone if invalid). */
  export function localDayIndex(now: Date, timeZone: string): number {
    let y: number, m: number, d: number;
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now);
      const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
      [y, m, d] = [get('year'), get('month'), get('day')] as [number, number, number];
    } catch {
      [y, m, d] = [now.getFullYear(), now.getMonth() + 1, now.getDate()];
    }
    return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  }
</script>

<script lang="ts">
  import type { BackgroundProps, ThemeManifest } from '@dash/contract';
  import { untrack, type Component } from 'svelte';
  import { session } from '../lib/session.svelte.js';
  import { themeAssetUrl } from './css-loader.js';
  import { sceneEnv, type SceneEnvStore } from './env.svelte.js';
  import { theme, type ThemeEngine } from './engine.svelte.js';
  import { createIntensityGovernor, type GovernorDeps } from './intensity.js';

  interface HostDeps {
    engine?: ThemeEngine;
    env?: SceneEnvStore;
    document?: GovernorDeps['document'];
    governor?: Partial<GovernorDeps>;
    timeZone?: () => string;
    assetUrl?: typeof themeAssetUrl;
  }
  type Background = ThemeManifest['backgrounds'][number];

  /**
   * `background` is `PageDto.background`: a scene id of the current theme, "rotate" (one scene per day),
   * or null/unknown (the theme's first scene). `deps` exists for tests.
   */
  let { background, deps = {} }: { background: string | null; deps?: HostDeps } = $props();

  const engine = untrack(() => deps.engine ?? theme);
  const env = untrack(() => deps.env ?? sceneEnv);
  const doc = untrack(() => deps.document ?? (document as GovernorDeps['document']));
  const timeZone = untrack(() => deps.timeZone ?? (() => session.me?.prefs.timeZone ?? 'UTC'));
  const assetUrl = untrack(() => deps.assetUrl ?? themeAssetUrl);
  const governorDeps = untrack(() => deps.governor ?? {});

  let hidden = $state(doc.hidden);
  const onVisibility = (): void => {
    hidden = doc.hidden;
  };

  // The governor and the minute ticker live exactly as long as this host.
  $effect(() => {
    const governor = createIntensityGovernor({ document: doc, ...governorDeps, apply: (i) => engine.setIntensity(i) });
    doc.addEventListener('visibilitychange', onVisibility);
    onVisibility();
    governor.start();
    env.start();
    return () => {
      governor.stop();
      env.stop();
      doc.removeEventListener('visibilitychange', onVisibility);
    };
  });

  const scene = $derived.by<Background | null>(() => {
    const list = engine.current.backgrounds;
    if (list.length === 0) return null;
    if (background === 'rotate') return list[localDayIndex(env.now, timeZone()) % list.length] ?? list[0] ?? null;
    return list.find((b) => b.id === background) ?? list[0] ?? null;
  });
  const key = $derived(scene ? `${engine.id}/${scene.id}` : '');
  const wantScene = $derived(scene !== null && engine.intensity !== 'static' && !hidden && !failedScenes.has(key));

  // ---- static image (always resolved; shown whenever no scene component is mounted) ----
  let image = $state<{ key: string; url: string } | null>(null);
  $effect(() => {
    const s = scene;
    const k = key;
    const themeId = engine.id;
    if (!s) return;
    let cancelled = false;
    assetUrl(themeId, s.staticImage).then(
      (url) => {
        if (!cancelled) image = { key: k, url };
      },
      (e: unknown) => report(`${k}#image`, e),
    );
    return () => {
      cancelled = true;
    };
  });

  // ---- scene component (imported only at calm/full while visible) ----
  let loaded = $state.raw<{ key: string; component: Component<BackgroundProps> } | null>(null);
  $effect(() => {
    const s = scene;
    const k = key;
    if (!s || !wantScene) return;
    let cancelled = false;
    s.component().then(
      (mod) => {
        if (!cancelled) loaded = { key: k, component: mod.default };
      },
      (e: unknown) => {
        report(k, e);
        failedScenes.add(k);
      },
    );
    return () => {
      cancelled = true;
    };
  });

  const Scene = $derived(wantScene && loaded && loaded.key === key ? loaded.component : null);
  const imageUrl = $derived(image && image.key === key ? image.url : null);

  function report(id: string, e: unknown): void {
    if (reported.has(id)) return;
    reported.add(id);
    console.error(`[theme] background "${id}" failed`, e);
  }
  function onSceneError(e: unknown): void {
    report(key, e);
    failedScenes.add(key);
  }
</script>

<div class="db-background" aria-hidden="true">
  {#if Scene}
    <svelte:boundary onerror={onSceneError}>
      <Scene mode={engine.mode} intensity={engine.intensity} {env} />
      {#snippet failed()}{/snippet}
    </svelte:boundary>
  {:else if imageUrl}
    <img class="db-background-image" src={imageUrl} alt="" decoding="async" />
  {/if}
</div>

<style>
  .db-background {
    position: fixed;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    overflow: hidden;
  }
  .db-background-image {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
</style>
