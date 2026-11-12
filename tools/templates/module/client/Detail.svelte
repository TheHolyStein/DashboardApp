<script lang="ts">
  import type { DetailProps } from '@dash/contract';

  let { data, level, t, close }: DetailProps<{ value: number; label: string }> = $props();
</script>

<section>
  <h2>{t('module.__ID__.detail', '__NAME__ detail')}</h2>
  {#if data}
    <p>{data.label}</p>
    <p>{data.value}</p>
  {/if}
  <button type="button" onclick={() => close()}>{t('module.__ID__.close', 'Close')}</button>
  {#if level === 'edit'}
    <button type="button" data-edit>{t('module.__ID__.edit', 'Edit')}</button>
  {/if}
</section>
