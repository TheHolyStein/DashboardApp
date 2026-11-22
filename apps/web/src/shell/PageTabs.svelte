<script lang="ts">
  import { tick } from 'svelte';
  import { t } from '../lib/i18n.js';
  import { pages } from '../lib/pages.svelte.js';
  import { session } from '../lib/session.svelte.js';

  let tabs = $state<HTMLElement[]>([]);

  $effect(() => {
    const el = tabs[pages.list.findIndex((p) => p.id === pages.currentId)];
    el?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  });

  async function onKey(e: KeyboardEvent, index: number): Promise<void> {
    const n = pages.list.length;
    const to =
      e.key === 'ArrowRight' ? Math.min(index + 1, n - 1)
      : e.key === 'ArrowLeft' ? Math.max(index - 1, 0)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? n - 1
      : -1;
    if (to < 0) return;
    e.preventDefault();
    const target = pages.list[to];
    if (!target) return;
    pages.select(target.id);
    await tick();
    tabs[to]?.focus();
  }
</script>

{#if pages.list.length > 0}
  <div class="tabs" role="tablist" aria-label={t('pages.tabs', 'Pages')}>
    {#each pages.list as page, i (page.id)}
      {@const selected = page.id === pages.currentId}
      {@const foreign = page.shared && page.ownerId !== session.me?.id}
      <button
        bind:this={tabs[i]}
        type="button"
        role="tab"
        id="tab-{page.id}"
        aria-selected={selected}
        tabindex={selected ? 0 : -1}
        data-icon={page.icon ?? undefined}
        data-shared={foreign || undefined}
        onclick={() => pages.select(page.id)}
        onkeydown={(e) => void onKey(e, i)}
      >
        {page.name}
        {#if foreign}<span class="shared">{t('pages.shared', 'shared')}</span>{/if}
      </button>
    {/each}
  </div>
{/if}

<style>
  .tabs { display: flex; gap: 4px; overflow-x: auto; padding: 4px 0; }
  button {
    flex: none; font: inherit; padding: 0.4rem 0.9rem; cursor: pointer; white-space: nowrap;
    color: var(--db-fg, #15181d); background: transparent; border: var(--db-border, 1px solid #c9ced6);
    border-radius: var(--db-radius, 8px);
  }
  button[aria-selected='true'] { background: var(--db-surface, #fff); border-color: var(--db-accent, #1f5fd1); font-weight: 600; }
  .shared { margin-left: 0.4em; font-size: 0.8em; color: var(--db-muted, #4a5260); }
</style>
