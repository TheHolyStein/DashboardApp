<script lang="ts">
  import type { BackgroundProps } from "@dash/contract";
  let { mode, intensity, env }: BackgroundProps = $props();
</script>

<div data-scene="b" data-mode={mode} data-intensity={intensity} data-weather={env.weather}></div>
