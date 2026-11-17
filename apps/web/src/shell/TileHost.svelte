<script lang="ts">
  import { getContext, onMount, setContext, untrack } from 'svelte';
  import type { Mode, ModuleClient, TileProps } from '@dash/contract';
  import { Button, ICONS_KEY, T_KEY, Tile } from '@dash/ui';
  import { clientModules } from '../generated/modules.js';
  import { detail } from '../lib/detail.svelte.js';
  import type { Instance } from '../lib/grid.js';
  import { baseProps, grantLevel, loadClient, lookupIcon, THEME_KEY, type HostRegistry, type ThemeSeam } from '../lib/host.js';
  import { t } from '../lib/i18n.js';
  import type { Page } from '../lib/pages.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import { ticker } from '../lib/ticker.svelte.js';
  import { openSettings } from '../lib/ui-state.svelte.js';

  // `page` is part of the frame contract (ownership and edit rights for later tasks).
  let {
    instance,
    page,
    modules = clientModules,
  }: { instance: Instance; page: Page; modules?: HostRegistry } = $props();

  const theme = getContext<ThemeSeam | undefined>(THEME_KEY);
  setContext(T_KEY, t);
  let moduleIcons = $state<Record<string, string>>({});
  setContext(ICONS_KEY, (name: string): string | undefined => lookupIcon(theme, moduleIcons, name));

  const entry = $derived(modules[instance.moduleId]);
  const title = $derived(entry ? t(`module.${entry.manifest.id}.name`, entry.manifest.name) : instance.moduleId);
  const mode = $derived<Mode>(theme?.mode ?? 'day');
  // Only an explicit view/edit grant gives access; the boolean only changes when access is gained or lost.
  const allowed = $derived(grantLevel(session.me?.grants, instance.moduleId) !== null);

  let attempt = $state(0);
  const loading = $derived.by(() => {
    void attempt; // retry loads again
    if (!allowed) return null;
    return loadClient(entry).then((loaded) => {
      moduleIcons = loaded.client.icons ?? {};
      return loaded;
    });
  });

  // Theme tile override: resolved reactively (theme identity, module, tile size), separately from loading the client.
  let override = $state.raw<ModuleClient['Tile'] | null>(null);
  let resolved = $state(!theme); // no theme: nothing to wait for
  let seq = 0;
  let warned = false;
  const width = $derived(instance.layout.w);
  const height = $derived(instance.layout.h);
  $effect(() => {
    const th = theme;
    if (!th) return;
    void th.id;
    const moduleId = instance.moduleId;
    const size = { w: width, h: height };
    const mine = ++seq; // only the latest resolve may apply
    if (!allowed) return;
    let pending: Promise<ModuleClient['Tile'] | null>;
    try {
      pending = untrack(() => th.tileFor(moduleId, size));
    } catch (e) {
      pending = Promise.reject(e);
    }
    pending.then(
      (c) => {
        if (mine !== seq) return;
        override = c;
        resolved = true;
      },
      (e: unknown) => {
        if (mine !== seq) return;
        if (!warned) {
          warned = true;
          console.warn('theme tile override failed; using the module tile', e);
        }
        override = null;
        resolved = true;
      },
    );
  });

  const base: ReturnType<typeof baseProps> = $derived(baseProps(instance, mode));
  const tileProps: TileProps = $derived({
    ...base,
    size: { w: instance.layout.w, h: instance.layout.h },
    openDetail: (params?: Record<string, string>) => detail.open(instance.id, params),
  });

  // Settings are for the page owner with edit level on the module (the server enforces both).
  const canConfigure = $derived(page.ownerId === session.me?.id && grantLevel(session.me?.grants, instance.moduleId) === 'edit');

  onMount(() => ticker.subscribe());
</script>

<Tile {title} icon={entry?.manifest.icon} stale={base.stale} updatedAt={base.updatedAt} now={ticker.now} onSettings={canConfigure ? () => openSettings(instance.id) : undefined}>
  {#if !allowed || !loading}
    <p class="unavailable" data-unavailable="true">{t('tile.unavailable', 'Module unavailable')}</p>
  {:else}
    {#await loading}
      <div class="skeleton" role="status" aria-label={t('tile.loading', 'Loading')}></div>
    {:then loaded}
      {#if resolved}
        {@const Body = override ?? loaded.client.Tile}
        <svelte:boundary>
          <Body {...tileProps} />
          {#snippet failed(error, reset)}
            {@render failure(reset, error)}
          {/snippet}
        </svelte:boundary>
      {:else}
        <div class="skeleton" role="status" aria-label={t('tile.loading', 'Loading')}></div>
      {/if}
    {:catch}
      {@render failure(() => attempt++, undefined)}
    {/await}
  {/if}
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
  .unavailable { margin: 0; color: var(--db-fg-muted, #4a5260); }
  .failed { display: grid; gap: 0.5rem; justify-items: start; color: var(--db-fg, #15181d); }
  .failed p { margin: 0; }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { .skeleton { animation: none; } }
</style>
