<script lang="ts">
  import { getContext, onMount, setContext, untrack, type Snippet } from 'svelte';
  import { ICONS_CONTEXT_KEY, T_CONTEXT_KEY, THEME_CONTEXT_KEY, type Mode, type ModuleClient, type ThemeSeam, type TileProps } from '@dash/contract';
  import { Button, Tile } from '@dash/ui';
  import { clientModules } from '../generated/modules.js';
  import { detail } from '../lib/detail.svelte.js';
  import type { Instance } from '../lib/grid.js';
  import { baseProps, grantLevel, loadClient, lookupIcon, type HostRegistry } from '../lib/host.js';
  import { t } from '../lib/i18n.js';
  import { pages, type Page } from '../lib/pages.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import { ticker } from '../lib/ticker.svelte.js';
  import { openSettings } from '../lib/ui-state.svelte.js';

  // `page` is part of the frame contract (ownership and edit rights for later tasks).
  let {
    instance,
    page,
    modules = clientModules,
    actions,
  }: { instance: Instance; page: Page; modules?: HostRegistry; actions?: Snippet | undefined } = $props();

  const theme = getContext<ThemeSeam | undefined>(THEME_CONTEXT_KEY);
  setContext(T_CONTEXT_KEY, t);
  let moduleIcons = $state<Record<string, string>>({});
  // Whether the whole frame opens the detail pane: known once the client has loaded (`detail: false` opts out).
  let hasDetail = $state(false);
  setContext(ICONS_CONTEXT_KEY, (name: string): string | undefined => lookupIcon(theme, moduleIcons, name));

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
      hasDetail = loaded.client.detail !== false;
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

  // The owner of the page owns its instances; on a shared page the viewer sees the owner's data read-only.
  const isOwner = $derived(page.ownerId === session.me?.id);
  const base: ReturnType<typeof baseProps> = $derived(baseProps(instance, mode, isOwner));
  const tileProps: TileProps = $derived({
    ...base,
    size: { w: instance.layout.w, h: instance.layout.h },
    openDetail: (params?: Record<string, string>) => detail.open(instance.id, params),
  });

  // Settings are for the page owner with edit level on the module (the server enforces both).
  const canConfigure = $derived(isOwner && grantLevel(session.me?.grants, instance.moduleId) === 'edit');

  const INTERACTIVE =
    'a, button, input, select, textarea, label, summary, [contenteditable], [contenteditable=""], [role=button], [role=link], [role=switch], [role=checkbox], [role=tab], [role=menuitem], [data-no-open]';
  // A press that moves more than this many px is a drag, not a click.
  const DRAG_PX = 5;
  // Not while arranging tiles (drag/resize), and not before the client has loaded or if it has no detail view.
  const openable = $derived(allowed && hasDetail && !pages.editing);
  const open = (): void => detail.open(instance.id);
  let frame: HTMLElement | undefined;
  // A frame click has no focused opener; focus returns to the title button, the keyboard entry point.
  const openFromFrame = (): void => detail.open(instance.id, {}, frame?.querySelector<HTMLElement>('button[aria-haspopup="dialog"]') ?? null);
  let pressAt: { x: number; y: number } | null = null;
  function onFramePointerDown(e: PointerEvent): void {
    pressAt = { x: e.clientX, y: e.clientY };
  }
  function onFrameClick(e: MouseEvent): void {
    const press = pressAt;
    pressAt = null;
    if (!openable || !(e.target instanceof Element) || e.target.closest(INTERACTIVE)) return;
    // Selecting text in the tile is not a click on the tile.
    if (window.getSelection()?.toString()) return;
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_PX) return;
    openFromFrame();
  }

  onMount(() => ticker.subscribe());
</script>

<!-- Mouse and touch: the whole frame opens the detail pane. Keyboard and assistive technology: the title button (Tile `onOpen`). -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="frame" bind:this={frame} class:openable data-openable={openable ? 'true' : undefined} onpointerdown={onFramePointerDown} onclick={onFrameClick}>
<Tile {title} icon={entry?.manifest.icon} stale={base.stale} updatedAt={base.updatedAt} now={ticker.now} onSettings={canConfigure ? () => openSettings(instance.id) : undefined} onOpen={openable ? open : undefined} {actions}>
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
</div>

{#snippet failure(retry: () => void, error: unknown)}
  <div class="failed" role="alert" data-failed="true">
    <p>{t('tile.failed', 'This module failed.')}</p>
    {#if import.meta.env.DEV && error}<pre class="err">{String(error)}</pre>{/if}
    <Button onclick={retry}>{t('tile.retry', 'Retry')}</Button>
  </div>
{/snippet}

<style>
  .frame { height: 100%; }
  .frame.openable { cursor: pointer; }
  .skeleton {
    height: 100%; min-height: 3rem; border-radius: var(--db-radius, 8px);
    background: linear-gradient(90deg, var(--db-surface-2, #eef0f4), var(--db-surface, #fff), var(--db-surface-2, #eef0f4));
    background-size: 200% 100%; animation: shimmer 1.4s linear infinite;
  }
  .unavailable { margin: 0; color: var(--db-muted); }
  .failed { display: grid; gap: 0.5rem; justify-items: start; color: var(--db-fg, #15181d); }
  .failed p { margin: 0; }
  @keyframes shimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
  @media (prefers-reduced-motion: reduce) { .skeleton { animation: none; } }
</style>
