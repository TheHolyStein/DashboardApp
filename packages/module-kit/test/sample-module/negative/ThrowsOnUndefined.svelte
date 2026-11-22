<script lang="ts">
  import type { TileProps } from '@dash/contract';
  let { data }: TileProps<{ value: number }> = $props();
  if (data === undefined) throw new Error('no data');
</script>

<p>ok</p>
