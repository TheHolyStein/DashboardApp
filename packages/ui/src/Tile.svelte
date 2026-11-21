<script lang="ts">
  import type { Snippet } from 'svelte';
  import { useT } from './context.js';
  import { formatRelative } from './relative.js';
  import Stale from './Stale.svelte';
  import TileHeader from './TileHeader.svelte';

  /** `now` drives the freshness text; the shell passes a shared ticker value so all tiles update together. */
  let {
    title,
    icon,
    stale = false,
    updatedAt,
    now,
    onSettings,
    onOpen,
    actions,
    children,
  }: {
    title: string;
    icon?: string | undefined;
    stale?: boolean | undefined;
    updatedAt?: string | null | undefined;
    now?: Date | undefined;
    onSettings?: (() => void) | undefined;
    /** Makes the title a button that opens the detail view. */
    onOpen?: (() => void) | undefined;
    /** Extra header controls after the settings button. */
    actions?: Snippet | undefined;
    children?: Snippet | undefined;
  } = $props();

  const t = useT();
  const fallbackNow = new Date();
  const freshness = $derived(updatedAt ? formatRelative(updatedAt, now ?? fallbackNow, t) : '');
</script>

<article class="surface" class:is-stale={stale}>
  <TileHeader {title} {icon} {onSettings} {onOpen} {actions} />
  <div class="body">{@render children?.()}</div>
  {#if updatedAt || stale}
    <footer class="foot">
      {#if stale}<Stale />{/if}
      {#if updatedAt}<time class="fresh" datetime={updatedAt}>{freshness}</time>{/if}
    </footer>
  {/if}
</article>

<style>
  .surface {
    display: flex; flex-direction: column; box-sizing: border-box; height: 100%; padding: var(--db-tile-pad, 12px);
    background: var(--db-surface, #fff); border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px);
    color: var(--db-fg, #15181d); overflow: hidden;
  }
  .body { flex: 1; min-height: 0; overflow: auto; }
  .foot { display: flex; gap: 0.5rem; align-items: center; justify-content: flex-end; margin-top: 0.5rem; font-size: 0.75rem; color: var(--db-muted, #4a5260); }
</style>
