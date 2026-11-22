<script lang="ts">
  // Test harness: runs `useNow` inside a component and prints the current instant.
  import { useNow } from '../client/useNow.svelte.js';

  let { seconds }: { seconds: boolean } = $props();
  const ticker = useNow({
    get seconds() {
      return seconds;
    },
  });
</script>

<output>{ticker.now.toISOString()}</output>
