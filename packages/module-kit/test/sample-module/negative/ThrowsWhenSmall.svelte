<script lang="ts">
  import type { TileProps } from '@dash/contract';
  let { size }: TileProps = $props();
  if (size.w < 3) throw new Error('too small');
</script>

<p>ok</p>
