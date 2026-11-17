<script lang="ts">
  import { Button } from '@dash/ui';
  import { t } from '../lib/i18n.js';
  import { stream, type StreamStatus } from '../lib/stream.svelte.js';
  import { updater } from '../lib/update.svelte.js';

  let {
    status = undefined,
    update = updater,
  }: { status?: StreamStatus | undefined; update?: { available: boolean; apply(): void } } = $props();

  const offline = $derived((status ?? stream.status) === 'offline');
</script>

{#if offline}
  <p class="banner" role="status" data-testid="offline-banner">{t('banner.offline', 'Offline — showing last data')}</p>
{/if}
{#if update.available}
  <div class="banner update" role="status">
    <span>{t('banner.update', 'Update available — reload')}</span>
    <Button variant="primary" onclick={() => update.apply()}>{t('banner.updateAction', 'Reload')}</Button>
  </div>
{/if}

<style>
  .banner {
    display: flex; gap: 0.75rem; align-items: center; justify-content: center; margin: 0; padding: 0.25rem 0.75rem; font-size: 0.85em;
    color: var(--db-fg, #15181d); background: var(--db-surface, #fff); border-bottom: var(--db-border, 1px solid #c9ced6);
  }
</style>
