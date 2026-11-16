<script lang="ts">
  import type { BackgroundProps } from "@dash/contract";
  let { mode }: BackgroundProps = $props();
  const boom = $derived.by(() => {
    throw new Error(`scene exploded in ${mode}`);
  });
</script>

<div data-scene="boom">{boom}</div>
