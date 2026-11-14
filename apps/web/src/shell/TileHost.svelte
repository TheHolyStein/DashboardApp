<script lang="ts">
  import { getContext, onMount, setContext } from 'svelte';
  import type { Mode, TileProps } from '@dash/contract';
  import { Button, ICONS_KEY, T_KEY, Tile } from '@dash/ui';
  import { clientModules } from '../generated/modules.js';
  import { detail } from '../lib/detail.svelte.js';
  import type { Instance } from '../lib/grid.js';
  import { baseProps, loadClient, THEME_KEY, type HostRegistry, type ThemeSeam } from '../lib/host.js';
  import { t } from '../lib/i18n.js';
  import type { Page } from '../lib/pages.svelte.js';
  import { ticker } from '../lib/ticker.svelte.js';

  // `page` is part of the frame contract (ownership and edit rights for later tasks).
  let {
    instance,
    modules = clientModules,
  }: { instance: Instance; page: Page; modules?: HostRegistry } = $props();

  const theme = getContext<ThemeSeam | undefined>(THEME_KEY);
  setContext(T_KEY, t);
  let moduleIcons = $state<Record<string, string>>({});
  setContext(ICONS_KEY, (name: string): string | undefined => theme?.icon?.(name) ?? moduleIcons[name]);

  const entry = $derived(modules[instance.moduleId]);
  const title = $derived(entry ? t(`module.${entry.manifest.id}.name`, entry.manifest.name) : instance.moduleId);
  const mode = $derived<Mode>(theme?.mode ?? 'day');

  let attempt = $state(0);
  const loading = $derived.by(() => {
    void attempt; // retry loads again
    const e = entry;
    return loadClient(e, theme, true).then((loaded) => {
      moduleIcons = loaded.client.icons ?? {};
      return loaded;
    });
  });

  const base: ReturnType<typeof baseProps> = $derived(baseProps(instance, mode));
  const tileProps: TileProps = $derived({
    ...base,
    size: { w: instance.layout.w, h: instance.layout.h },
    openDetail: (params?: Record<string, string>) => detail.open(instance.id, params),
  });

  onMount(() => ticker.subscribe());
</script>

<Tile {title} icon={entry?.manifest.icon} stale={base.stale} updatedAt={base.updatedAt} now={ticker.now}>
  {#await loading}
    <div class="skeleton" role="status" aria-label={t('tile.loading', 'Loading')}></div>
  {:then loaded}
    {@const Body = loaded.override ?? loaded.client.Tile}
    <svelte:boundary>
      <Body {...tileProps} />
      {#snippet failed(error, reset)}
        {@render failure(reset, error)}
      {/snippet}
    </svelte:boundary>
  {:catch}
    {@render failure(() => attempt++, undefined)}
  {/await}
</Tile>

{#snippet failure(retry: () => void, error: unknown)}
  <div class="failed" role="alert" data-failed="true">
    <p>{t('tile.failed', 'This module failed.')}</p>
    {#if import.meta.env.DEV && error}<pre class="err">{String(error)}</pre>{/if}
    <Button onclick={retry}>{t('tile.retry', 'Retry')}</Button>
  </div>
{/snippet}

<style>
  .skeleton {
    height: 100%; min-height: 3rem; border-radius: var(--db-radius, 8px);
    background: linear-gradient(90deg, var(--db-surface-2, #eef0f4), var(--db-surface, #fff), var(--db-surface-2, #eef0f4));
    background-size: 200% 100%; animation: shimmer 1.4s linear infinite;
  }
  .failed { display: grid; gap: 0.5rem; justify-items: start; color: var(--db-fg, #15181d); }
  .failed p { margin: 0; }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { .skeleton { animation: none; } }
</style>
