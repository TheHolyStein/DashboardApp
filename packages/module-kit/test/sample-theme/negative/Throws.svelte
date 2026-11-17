<script lang="ts">
  import type { BackgroundProps } from '@dash/contract';
  let { mode }: BackgroundProps = $props();
  if (mode === 'night') throw new Error('night unsupported');
</script>

<div></div>
