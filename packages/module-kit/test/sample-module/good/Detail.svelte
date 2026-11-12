<script lang="ts">
  import type { DetailProps } from '@dash/contract';

  let { data, level, t, close }: DetailProps<{ value: number; label: string; history?: number[] }> = $props();
</script>

<section>
  <h2>{t('module.sample.detail', 'Sample detail')}</h2>
  {#if data}
    <p>{data.label}</p>
    <ul>
      {#each data.history ?? [] as point (point)}
        <li>{point}</li>
      {/each}
    </ul>
  {/if}
  <button type="button" onclick={() => close()}>{t('module.sample.close', 'Close')}</button>
  {#if level === 'edit'}
    <button type="button" data-edit>{t('module.sample.reset', 'Reset')}</button>
  {/if}
</section>
