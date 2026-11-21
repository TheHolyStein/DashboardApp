<script lang="ts">
  import type { Snippet } from 'svelte';
  import { useT } from './context.js';
  import Icon from './Icon.svelte';

  /** `onOpen` turns the title into a button (`aria-haspopup="dialog"`) that opens the tile's detail view. */
  let {
    title,
    icon,
    onSettings,
    onOpen,
    actions,
  }: {
    title: string;
    icon?: string | undefined;
    onSettings?: (() => void) | undefined;
    onOpen?: (() => void) | undefined;
    /** Extra controls after the settings button (the shell puts the edit-mode remove button here). */
    actions?: Snippet | undefined;
  } = $props();
  const t = useT();
</script>

<header class="head">
  {#if icon}<Icon name={icon} size={18} />{/if}
  <h2 class="title">
    {#if onOpen}
      <button type="button" class="open" aria-haspopup="dialog" onclick={onOpen}>{title}</button>
    {:else}{title}{/if}
  </h2>
  {#if onSettings}
    <button type="button" class="settings" aria-label={t('tile.settings', 'Tile settings')} onclick={onSettings}>
      <Icon name="settings" size={18} />
    </button>
  {/if}
  {@render actions?.()}
</header>

<style>
  .head { display: flex; align-items: center; gap: 0.25rem; margin-bottom: 0.5rem; color: var(--db-fg, #15181d); }
  .title { flex: 1; margin: 0; font-size: 0.95rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .open { font: inherit; color: inherit; background: none; border: 0; padding: 0; margin: 0; max-width: 100%; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; border-radius: var(--db-radius, 8px); }
  .open:focus-visible { outline: 2px solid var(--db-focus, #1d4ed8); outline-offset: 2px; }
  .settings {
    display: inline-flex; align-items: center; justify-content: center; min-width: 2rem; min-height: 2rem; padding: 0.25rem; border: 0; background: transparent; color: var(--db-muted, #4a5260);
    border-radius: var(--db-radius, 8px); cursor: pointer;
  }
  .settings:hover { color: var(--db-fg, #15181d); }
  .settings:focus-visible { outline: 2px solid var(--db-focus, #1d4ed8); outline-offset: 2px; }
</style>
