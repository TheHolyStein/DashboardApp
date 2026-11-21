<script lang="ts">
  // Shopping "store mode": the list full-screen with big touch targets; a tap strikes an item (a second tap undoes it).
  import { onMount } from 'svelte';
  import type { Translate } from '@dash/contract';
  import type { Row } from './model.js';

  type Props = { rows: Row[]; t: Translate; onclose: () => void; ontap: (row: Row) => void };
  let { rows, t, onclose, ontap }: Props = $props();

  let closeButton = $state<HTMLButtonElement>();
  onMount(() => closeButton?.focus());
  const open = $derived(rows.filter((r) => !r.done).length);
</script>

<svelte:window onkeydown={(e) => { if (e.key === 'Escape') onclose(); }} />

<div class="store" role="dialog" aria-modal="true" aria-label={t('m.todo.storeMode', 'Store mode')}>
  <header>
    <h3>{t('m.todo.list.shopping', 'Shopping')} <span class="left" data-value>{open}</span></h3>
    <button type="button" class="close" bind:this={closeButton} onclick={onclose}>{t('m.todo.storeClose', 'Done shopping')}</button>
  </header>
  <ul>
    {#each rows as row (row.id)}
      <li>
        <button type="button" data-edit class="item" class:struck={row.done} aria-pressed={row.done} onclick={() => ontap(row)}>
          <span class="title" data-user>{row.title}</span>
          {#if row.qty}<span class="qty" data-user>{row.qty}</span>{/if}
        </button>
      </li>
    {/each}
  </ul>
</div>

<style>
  .store { position: fixed; inset: 0; z-index: 1000; display: flex; flex-direction: column; padding: 1rem; overflow: auto; color: var(--db-fg); background: var(--db-surface); }
  header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; }
  h3 { margin: 0; font-size: 1.5rem; }
  .left { color: var(--db-muted); font-variant-numeric: tabular-nums; }
  ul { display: grid; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
  .item, .close { width: 100%; min-height: 4rem; padding: 0.75rem 1rem; font: inherit; font-size: 1.4rem; text-align: left; color: var(--db-fg); background: var(--db-surface-2, var(--db-surface)); border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px); cursor: pointer; display: flex; justify-content: space-between; gap: 1rem; }
  .close { width: auto; min-height: 3.5rem; justify-content: center; }
  .item:focus-visible, .close:focus-visible { outline: 3px solid var(--db-focus, #1d4ed8); outline-offset: 2px; }
  .item.struck .title { text-decoration: line-through; color: var(--db-muted); }
  .item.struck { opacity: 0.75; }
  .qty { color: var(--db-muted); }
</style>
