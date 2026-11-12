<script lang="ts">
  import type { TileProps } from '@dash/contract';

  let { data, stale, level, t, openDetail }: TileProps<{ value: number; label: string }> = $props();
</script>

<section class:stale>
  <h3>{t('module.__ID__.title', '__NAME__')}</h3>
  {#if data}
    <p>{data.label}</p>
    <p>{data.value}</p>
  {:else}
    <p>{t('module.__ID__.loading', 'Loading')}</p>
  {/if}
  {#if stale}
    <p>{t('module.__ID__.stale', 'Out of date')}</p>
  {/if}
  <button type="button" onclick={() => openDetail()}>{t('module.__ID__.open', 'Open')}</button>
  {#if level === 'edit'}
    <button type="button" data-edit>{t('module.__ID__.edit', 'Edit')}</button>
  {/if}
</section>
