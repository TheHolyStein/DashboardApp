<script lang="ts">
  import type { TileProps } from '@dash/contract';
  let { mode }: TileProps = $props();
  if (mode === 'night') throw new Error('night unsupported');
</script>

<p>ok</p>
