<script lang="ts">
  import { onMount } from 'svelte';
  import type { BackgroundProps } from '@dash/contract';
  let { intensity }: BackgroundProps = $props();
  onMount(() => {
    // Schedules the frame a microtask later, after a naive synchronous check.
    if (intensity === 'static') void Promise.resolve().then(() => requestAnimationFrame(() => undefined));
  });
</script>

<div></div>
