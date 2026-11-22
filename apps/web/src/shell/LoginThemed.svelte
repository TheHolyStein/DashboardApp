<script lang="ts">
  import { recallTheme } from '../lib/prefs.js';
  import { theme } from '../theme/engine.svelte.js';
  import Login from './Login.svelte';

  let { failed = false }: { failed?: boolean } = $props();

  // The user is unknown before sign-in: use the last theme and mode policy remembered on this device.
  $effect(() => {
    const last = recallTheme();
    theme.setPolicy(last.modePolicy);
    void theme.set(last.theme);
  });
</script>

<Login {failed} />
