<script lang="ts">
  import type { DetailProps } from '@dash/contract';
  import { Button, serial } from '@dash/ui';

  let { data, level, t, api, close }: DetailProps<{ value: number; label: string }> = $props();

  let text = $state('');
  let busy = $state(false);
  let failed = $state(false);

  // serial(): clicks run one after another, so a list that is read-modified-written never loses an update.
  const add = serial(async (label: string): Promise<void> => {
    busy = true;
    failed = false;
    try {
      await api.post('/items', { label });
      text = '';
    } catch {
      failed = true; // a svelte:boundary does not catch async errors: handle your own rejections
    } finally {
      busy = false;
    }
  });
</script>

<section>
  <h2>{t('m.__ID__.detail', '__NAME__ detail')}</h2>
  {#if data}
    <p>{data.label}</p>
    <p><span data-value>{data.value}</span></p>
  {/if}
  {#if level === 'edit'}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        void add(text);
      }}
    >
      <label>{t('m.__ID__.label', 'Label')}<input bind:value={text} maxlength="80" required data-edit /></label>
      <Button type="submit" {busy} data-edit>{t('m.__ID__.add', 'Add')}</Button>
    </form>
    {#if failed}<p role="alert">{t('m.__ID__.failed', 'Could not save.')}</p>{/if}
  {/if}
  <Button onclick={() => close()}>{t('m.__ID__.close', 'Close')}</Button>
</section>
