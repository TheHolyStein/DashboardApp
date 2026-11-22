<script lang="ts">
  import type { TileProps } from '@dash/contract';
  let { data, stale, t }: TileProps<{ label: string }> = $props();
</script>

<p>{t('module.sample.title', 'Sample')}</p>
{#if data === undefined}
  <p>no data yet</p>
{/if}
{#if stale}
  <p>old</p>
{/if}
