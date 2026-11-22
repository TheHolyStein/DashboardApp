<script lang="ts">
  import type { TileProps } from '@dash/contract';
  let { stale }: TileProps = $props();
  if (stale) throw new Error('stale unsupported');
</script>

<p>ok</p>
