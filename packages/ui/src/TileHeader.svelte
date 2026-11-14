<script lang="ts">
  import { useT } from './context.js';
  import Icon from './Icon.svelte';

  let { title, icon, onSettings }: { title: string; icon?: string | undefined; onSettings?: (() => void) | undefined } = $props();
  const t = useT();
</script>

<header class="head">
  {#if icon}<Icon name={icon} size={18} />{/if}
  <h2 class="title">{title}</h2>
  {#if onSettings}
    <button type="button" class="settings" aria-label={t('tile.settings', 'Tile settings')} onclick={onSettings}>
      <Icon name="settings" size={18} />
    </button>
  {/if}
</header>

<style>
  .head { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; color: var(--db-fg, #15181d); }
  .title { flex: 1; margin: 0; font-size: 0.95rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .settings {
    display: inline-flex; padding: 0.25rem; border: 0; background: transparent; color: var(--db-muted, #4a5260);
    border-radius: var(--db-radius, 8px); cursor: pointer;
  }
  .settings:hover { color: var(--db-fg, #15181d); }
  .settings:focus-visible { outline: 2px solid var(--db-focus, #1d4ed8); outline-offset: 2px; }
</style>
