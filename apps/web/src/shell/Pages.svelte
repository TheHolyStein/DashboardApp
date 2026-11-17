<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { clientModules } from '../generated/modules.js';
  import type { GridFactory, IntersectionCallback as IOCallback, IntersectionLike as IO, MediaQueryLike as MQ, MediaFactory, ObserverFactory, ModuleRegistry } from '../lib/grid.js';
  import { t } from '../lib/i18n.js';
  import { pages } from '../lib/pages.svelte.js';
  import { stream } from '../lib/stream.svelte.js';
  import Grid from './Grid.svelte';
  import MobileStack from './MobileStack.svelte';

  // jsdom lacks matchMedia and IntersectionObserver: fall back to the window width / no visibility reports.
  function defaultMatchMedia(q: string): MQ {
    if (typeof window.matchMedia === 'function') return window.matchMedia(q);
    return { matches: window.innerWidth >= 900, addEventListener: () => {}, removeEventListener: () => {} };
  }
  function defaultObserver(cb: IOCallback): IO {
    if (typeof IntersectionObserver === 'undefined') return { observe: () => {}, disconnect: () => {} };
    return new IntersectionObserver((entries) => cb(entries));
  }

  let {
    modules = clientModules,
    matchMedia = defaultMatchMedia,
    observerFactory = defaultObserver,
    gridFactory,
  }: {
    modules?: ModuleRegistry;
    matchMedia?: MediaFactory;
    observerFactory?: ObserverFactory;
    gridFactory?: GridFactory | undefined;
  } = $props();

  const mq = untrack(() => matchMedia('(min-width: 900px)'));
  let wide = $state(mq.matches); // synchronous, so desktop never flashes the stack
  let container = $state<HTMLElement | null>(null);

  onMount(() => {
    wide = mq.matches;
    const on = (): void => {
      wide = mq.matches;
    };
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });

  // Tell the stream which tiles are on screen.
  $effect(() => {
    const el = container;
    // One key per set of tile elements in the DOM: mode, page and its instance ids.
    void `${wide ? 'grid' : 'stack'}|${pages.currentId}|${pages.current?.instances.map((i) => i.id).join(',')}`;
    if (!el) return;
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- plain bookkeeping, not rendered
    const visible = new Set<string>();
    const io = observerFactory((entries) => {
      for (const e of entries) {
        const id = (e.target as HTMLElement).dataset.instanceId;
        if (!id) continue;
        if (e.isIntersecting) visible.add(id);
        else visible.delete(id);
      }
      stream.setVisible([...visible]);
    });
    for (const tile of el.querySelectorAll('[data-instance-id]')) io.observe(tile);
    return () => {
      io.disconnect();
      stream.setVisible([]);
    };
  });
</script>

<div class="pages" bind:this={container} data-region="pages" data-focus-fallback tabindex="-1">
  {#if pages.status === 'loading' || pages.status === 'idle'}
    <p class="state" role="status">{t('pages.loading', 'Loading pages…')}</p>
  {:else if pages.status === 'error' && !pages.current}
    <div class="state" role="alert">
      <p>{t('pages.error', 'Could not load your pages.')}</p>
      <button type="button" onclick={() => void pages.load()}>{t('pages.retry', 'Retry')}</button>
    </div>
  {:else if pages.current}
    {#key pages.current.id}
      <div class="page">
        {#if pages.current.instances.length === 0}
          <p class="state">{t('pages.empty', 'This page is empty.')}</p>
        {:else if wide}
          <Grid page={pages.current} {modules} {gridFactory} />
        {:else}
          <MobileStack page={pages.current} {modules} />
        {/if}
      </div>
    {/key}
  {/if}
</div>

<style>
  .pages { padding: var(--db-gap, 8px) 0; }
  .state { padding: 1rem; color: var(--db-muted, #4a5260); }
  .page { animation: page-in 150ms ease-out; }
  button {
    font: inherit; padding: 0.5rem 1rem; color: var(--db-fg, #15181d); background: var(--db-surface, #fff);
    border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px); cursor: pointer;
  }
  @keyframes page-in { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .page { animation: none; } }
</style>
