<script lang="ts">
  import { onMount } from 'svelte';
  import type { BackgroundProps } from '@dash/contract';
  let { intensity }: BackgroundProps = $props();
  onMount(() => {
    // Only animates when allowed, but forgets to stop on teardown.
    if (intensity !== 'static') setInterval(() => undefined, 1000);
  });
</script>

<div></div>
