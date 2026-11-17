<script lang="ts">
  import type { TileProps } from '@dash/contract';

  let { data, stale, level, t, openDetail }: TileProps<{ value: number; label: string }> = $props();
</script>

<section class:stale>
  <h3>{t('module.clock.title', 'Clock')}</h3>
  {#if data}
    <p>{data.label}</p>
    <p>{data.value}</p>
  {:else}
    <p>{t('module.clock.loading', 'Loading')}</p>
  {/if}
  {#if stale}
    <p>{t('module.clock.stale', 'Out of date')}</p>
  {/if}
  <button type="button" onclick={() => openDetail()}>{t('module.clock.open', 'Open')}</button>
  {#if level === 'edit'}
    <button type="button" data-edit>{t('module.clock.edit', 'Edit')}</button>
  {/if}
</section>
