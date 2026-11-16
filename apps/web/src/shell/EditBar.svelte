<script lang="ts">
  import { Button } from '@dash/ui';
  import { t } from '../lib/i18n.js';
  import { pages } from '../lib/pages.svelte.js';
  import { session } from '../lib/session.svelte.js';
  import { catalogUi } from './Catalog.svelte';

  const owned = $derived(!!pages.current && pages.current.ownerId === session.me?.id);

  // Leaving for a page the user does not own ends edit mode (flushes pending saves).
  $effect(() => {
    if (pages.editing && pages.current && !owned) pages.setEditing(false);
  });
</script>

{#if owned}
  <div class="bar" role="toolbar" aria-label={t('edit.toolbar', 'Page editing')}>
    {#if pages.editing}
      <Button variant="primary" data-edit onclick={() => (catalogUi.open = true)}>{t('edit.add', 'Add module')}</Button>
      <Button onclick={() => pages.setEditing(false)}>{t('edit.done', 'Done')}</Button>
    {:else}
      <Button aria-label={t('edit.start', 'Edit page')} onclick={() => pages.setEditing(true)}>✎</Button>
    {/if}
  </div>
{/if}

<style>
  .bar { display: flex; gap: 0.5rem; justify-content: flex-end; padding: 0 var(--db-gap, 8px); }
</style>
