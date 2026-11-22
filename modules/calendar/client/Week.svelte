<script lang="ts">
  // Week view: seven days from the week start, or three days from the cursor on narrow screens.
  import type { ComponentProps } from 'svelte';
  import { addDays, startOfWeek } from './format.js';
  import TimeGrid from './TimeGrid.svelte';

  type GridProps = Omit<ComponentProps<typeof TimeGrid>, 'days'>;
  let { cursor, weekStart, narrow, ...grid }: GridProps & { cursor: string; weekStart: 'mon' | 'sun'; narrow: boolean } = $props();

  const days = $derived(
    narrow ? [0, 1, 2].map((i) => addDays(cursor, i)) : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(cursor, weekStart), i)),
  );
</script>

<TimeGrid {days} {...grid} />
