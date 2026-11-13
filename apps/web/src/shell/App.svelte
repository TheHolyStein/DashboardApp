<script lang="ts">
  import { onMount } from 'svelte';
  import { session } from '../lib/session.svelte.js';
  import { t } from '../lib/i18n.js';
  import Login from './Login.svelte';

  let failed = $state(false);

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
  <!-- Boundary for later tasks: the top bar and the pages/grid replace this region. -->
  <main class="signed-in" data-region="shell-content">
    <p>{t('shell.signedInAs', 'Signed in as {name}', { name: session.me.name })}</p>
    <button type="button" onclick={() => void session.logout()}>{t('shell.signOut', 'Sign out')}</button>
  </main>
{/if}

<style>
  .status, .signed-in { padding: 1rem; }
  button {
    font: inherit; padding: 0.5rem 1rem; color: var(--db-fg, #15181d); background: var(--db-surface, #fff);
    border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px); cursor: pointer;
  }
</style>
