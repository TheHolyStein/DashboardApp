<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { notifications } from '../lib/notifications.svelte.js';
  import { offline } from '../lib/offline.svelte.js';
  import { pages } from '../lib/pages.svelte.js';
  import { loadIntensityOverride } from '../lib/prefs.js';
  import { session } from '../lib/session.svelte.js';
  import { t } from '../lib/i18n.js';
  import ThemeRoot from '../theme/ThemeRoot.svelte';
  import { setUserIntensityOverride } from '../theme/intensity.js';
  import LoginThemed from './LoginThemed.svelte';
  import Shell from './Shell.svelte';

  let failed = $state(false);

  // Load pages and notifications once signed in; drop them (and unsent saves, stored offline state) on sign-out.
  // While showing stored state offline nothing is requested; leaving that state (the session came back) loads them.
  $effect(() => {
    const status = session.status;
    const restored = offline.restored;
    // untrack: the stores read and write their own state; only the session status and the offline flag may trigger this.
    untrack(() => {
      if (status === 'signedIn') {
        if (restored) return;
        void pages.load();
        notifications.start();
        offline.start();
      } else if (status === 'signedOut') {
        pages.clear();
        notifications.clear();
        offline.clear();
      }
    });
  });

  onMount(() => {
    setUserIntensityOverride(loadIntensityOverride());
    session.refresh().catch(() => {
      // Cannot reach the server: with a stored layout, show it (stale) and keep retrying quietly.
      if (offline.restore()) return;
      failed = true;
      session.clear();
    });
  });
</script>

{#if session.status === 'loading'}
  <p class="status" role="status">{t('shell.loading', 'Loading…')}</p>
{:else if session.status === 'signedOut'}
  <LoginThemed {failed} />
{:else if session.me}
  <ThemeRoot>
    <Shell />
  </ThemeRoot>
{/if}

<style>
  .status { padding: 1rem; }
</style>
