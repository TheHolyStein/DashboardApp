<script lang="ts">
  import type { TileProps } from '@dash/contract';
  let { data }: TileProps<{ label: string }> = $props();
</script>

<!-- "Kitchen" is fixture data; "kit" is a substring of it but a hard-coded word. -->
<p>{data?.label}</p>
<p>kit</p>
