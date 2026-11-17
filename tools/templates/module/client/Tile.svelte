<script lang="ts">
  import type { TileProps } from '@dash/contract';

  // The shell opens the detail view when the tile frame (or its title) is activated; no open button needed.
  // Set `detail: false` in client/index.ts for a tile without a detail view.
  let { data, stale, level, t }: TileProps<{ value: number; label: string }> = $props();
</script>

<section class:stale>
  <h3>{t('m.__ID__.title', '__NAME__')}</h3>
  {#if data}
    <p>{data.label}</p>
    <!-- Formatted numbers, times and dates are data, not words: mark them with data-value instead of wrapping in t(). -->
    <p><span data-value>{data.value}</span></p>
  {:else}
    <p>{t('m.__ID__.loading', 'Loading')}</p>
  {/if}
  <!-- The frame already shows a stale badge; do not re-implement it. Just do not invent progress from stale data. -->
  {#if level === 'edit'}
    <button type="button" data-edit>{t('m.__ID__.edit', 'Edit')}</button>
  {/if}
</section>
