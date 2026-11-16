<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { session } from '../lib/session.svelte.js';
  import { t } from '../lib/i18n.js';
  import { pages } from '../lib/pages.svelte.js';
  import Catalog from './Catalog.svelte';
  import DetailHost from './DetailHost.svelte';
  import EditBar from './EditBar.svelte';
  import Login from './Login.svelte';
  import PageTabs from './PageTabs.svelte';
  import Pages from './Pages.svelte';
  import SettingsDialog from './SettingsDialog.svelte';

  let failed = $state(false);

  // Load pages once signed in; drop them (and unsent saves) on sign-out.
  $effect(() => {
    const status = session.status;
    // untrack: the store reads and writes its own state; only the session status may trigger this.
    untrack(() => {
      if (status === 'signedIn') void pages.load();
      else if (status === 'signedOut') pages.clear();
    });
  });

  onMount(() => {
    session.refresh().catch(() => {
      failed = true;
      session.clear();
    });
  });
</script>

{#if session.status === 'loading'}
  <p class="status" role="status">{t('shell.loading', 'Loading…')}</p>
{:else if session.status === 'signedOut'}
  <Login {failed} />
{:else if session.me}
  <!-- Boundary for later tasks: a top bar goes above PageTabs. -->
  <main class="signed-in" data-region="shell-content">
    <p>{t('shell.signedInAs', 'Signed in as {name}', { name: session.me.name })}</p>
    <button type="button" onclick={() => void session.logout()}>{t('shell.signOut', 'Sign out')}</button>
    <PageTabs />
    <EditBar />
    <Pages />
    <DetailHost />
    <SettingsDialog />
    <Catalog />
  </main>
{/if}

<style>
  .status, .signed-in { padding: 1rem; }
  button {
    font: inherit; padding: 0.5rem 1rem; color: var(--db-fg, #15181d); background: var(--db-surface, #fff);
    border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px); cursor: pointer;
  }
</style>
