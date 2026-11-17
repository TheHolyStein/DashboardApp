<script lang="ts">
  import type { DetailProps } from '@dash/contract';

  let { data, level, t, close }: DetailProps<{ value: number; label: string }> = $props();
</script>

<section>
  <h2>{t('module.clock.detail', 'Clock detail')}</h2>
  {#if data}
    <p>{data.label}</p>
    <p>{data.value}</p>
  {/if}
  <button type="button" onclick={() => close()}>{t('module.clock.close', 'Close')}</button>
  {#if level === 'edit'}
    <button type="button" data-edit>{t('module.clock.edit', 'Edit')}</button>
  {/if}
</section>
