<script lang="ts">
  import { onMount } from 'svelte';
  import type { BackgroundProps } from '@dash/contract';
  let { intensity }: BackgroundProps = $props();
  onMount(() => {
    if (intensity === 'static') return undefined;
    const id = requestAnimationFrame(() => undefined);
    return () => cancelAnimationFrame(id);
  });
</script>

<div></div>
