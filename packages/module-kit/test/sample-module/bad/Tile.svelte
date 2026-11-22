<script lang="ts">
  import type { TileProps } from '@dash/contract';

  let { data }: TileProps<{ value: number; label: string }> = $props();
</script>

<section>
  <h3>Hard coded heading</h3>
  <p>{data?.value}</p>
  <button type="button" data-edit>Delete everything</button>
</section>
