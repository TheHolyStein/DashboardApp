<script lang="ts">
  // Day view: one column of the time grid.
  import type { ComponentProps } from 'svelte';
  import TimeGrid from './TimeGrid.svelte';

  type GridProps = Omit<ComponentProps<typeof TimeGrid>, 'days'>;
  let { cursor, ...grid }: GridProps & { cursor: string } = $props();
</script>

<TimeGrid days={[cursor]} {...grid} />
