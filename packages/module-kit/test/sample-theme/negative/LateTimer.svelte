<script lang="ts">
  import { onMount } from 'svelte';
  import type { BackgroundProps } from '@dash/contract';
  let { intensity }: BackgroundProps = $props();
  onMount(() => {
    // Starts an interval from a timer callback, then never stops it.
    if (intensity === 'calm') setTimeout(() => setInterval(() => undefined, 1000), 0);
  });
</script>

<div></div>
