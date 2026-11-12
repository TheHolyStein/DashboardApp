<script lang="ts">
  import type { TileProps } from '@dash/contract';

  let { data, stale, level, t, openDetail }: TileProps<{ value: number; label: string }> = $props();
</script>

<section class:stale>
  <h3>{t('module.sample.title', 'Sample')}</h3>
  {#if data}
    <p>{data.label}</p>
    <p>{data.value}</p>
  {:else}
    <p>{t('module.sample.loading', 'Loading')}</p>
  {/if}
  {#if stale}
    <p>{t('module.sample.stale', 'Out of date')}</p>
  {/if}
  <button type="button" onclick={() => openDetail()}>{t('module.sample.open', 'Open')}</button>
  {#if level === 'edit'}
    <button type="button" data-edit>{t('module.sample.add', 'Add')}</button>
  {/if}
</section>
