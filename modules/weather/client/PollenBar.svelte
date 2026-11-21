<script lang="ts">
  import type { PollenLevel } from '../manifest.js';

  // Five segments, `level` of them filled. The meaning is in the label, not in the colour.
  let { level, label }: { level: PollenLevel | null; label: string } = $props();
</script>

<span class="bar" role="img" aria-label={label}>
  {#each [1, 2, 3, 4, 5] as n (n)}
    <span class="seg" class:on={level !== null && n <= level}></span>
  {/each}
</span>

<style>
  .bar {
    display: inline-flex;
    gap: 2px;
    vertical-align: middle;
  }
  .seg {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 2px;
    background: var(--db-surface-2, transparent);
    border: 1px solid var(--db-border-color, currentColor);
    box-sizing: border-box;
  }
  .seg.on {
    background: var(--db-accent, currentColor);
    border-color: var(--db-accent, currentColor);
  }
</style>
