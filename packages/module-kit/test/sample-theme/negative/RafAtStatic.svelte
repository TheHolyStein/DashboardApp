<script lang="ts">
  import { onMount } from 'svelte';
  import type { BackgroundProps } from '@dash/contract';
  let { intensity }: BackgroundProps = $props();
  onMount(() => {
    // Schedules a frame at static and never cancels it.
    if (intensity === 'static') requestAnimationFrame(() => undefined);
  });
</script>

<div></div>
