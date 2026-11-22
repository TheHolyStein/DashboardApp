<script lang="ts">
  // Notifications tile: the unread count and the newest unread notifications. Needs-setup state: not applicable, the
  // module has nothing to configure. Nothing in the tile is interactive: the shell's tile frame opens the detail pane.
  import { untrack } from 'svelte';
  import type { TileProps } from '@dash/contract';
  import type { Snapshot } from '../manifest.js';
  import { levelClass, levelName } from './format.js';

  let { data: pushed, size, t, locale }: TileProps<Snapshot> = $props();

  // A snapshot older than the one on screen (a late or reordered push) is ignored; a new server epoch always wins.
  let data = $state.raw<Snapshot | undefined>(untrack(() => pushed));
  $effect.pre(() => {
    const next = pushed;
    untrack(() => {
      if (next && (!data || next.epoch !== data.epoch || next.rev >= data.rev)) data = next;
    });
  });

  // One row of height has room for the count only; the default size lists three, a tall tile five.
  const rows = $derived(size.h >= 4 ? 5 : size.h >= 2 ? 3 : 0);
  const shown = $derived((data?.latest ?? []).slice(0, rows));
  const count = $derived.by(() => {
    const n = data?.unread ?? 0;
    try {
      return new Intl.NumberFormat(locale).format(n);
    } catch {
      return String(n);
    }
  });
</script>

<div class="notifications-tile">
  {#if data}
    <p class="summary">
      {#if data.unread > 0}
        <span class="count" data-value>{count}</span>
        <span class="label">{t('m.notifications.unread', 'unread')}</span>
      {:else}
        <span class="label">{t('m.notifications.allRead', 'All caught up')}</span>
      {/if}
    </p>
    {#if shown.length > 0}
      <ul>
        {#each shown as n (n.id)}
          <li class={levelClass(n.level)}>
            <span class="level">{levelName(n.level, t)}</span>
            <span class="title" data-user>{n.title}</span>
            <span class="module" data-value>{n.moduleId}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {:else}
    <p class="label">{t('m.notifications.waiting', 'Waiting for notifications…')}</p>
  {/if}
</div>

<style>
  .notifications-tile {
    container-type: inline-size;
    display: grid;
    gap: var(--db-gap, 8px);
    align-content: start;
    width: 100%;
    height: 100%;
    color: var(--db-fg);
  }
  p,
  ul {
    margin: 0;
    padding: 0;
  }
  .count {
    font-family: var(--db-font-display);
    font-size: 2rem;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .label,
  .level,
  .module {
    color: var(--db-muted);
  }
  ul {
    display: grid;
    gap: 0.25rem;
    list-style: none;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.5rem;
    border-inline-start: 4px solid var(--db-accent);
    padding-inline-start: 0.5rem;
  }
  li.warn {
    border-inline-start-color: var(--db-warn);
  }
  li.critical {
    border-inline-start-color: var(--db-crit);
  }
  .title {
    font-weight: 600;
  }
</style>
