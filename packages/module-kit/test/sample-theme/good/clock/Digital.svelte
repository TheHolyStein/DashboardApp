<script lang="ts">
  import type { ClockFaceProps } from '@dash/contract';

  let { now, showSeconds, hour12, timeZone, label }: ClockFaceProps = $props();

  const text = $derived(
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      second: showSeconds ? '2-digit' : undefined,
      hour12,
      timeZone,
    }).format(now),
  );
</script>

<div class="digital">
  <time datetime={now.toISOString()}>{text}</time>
  {#if label}<span class="label">{label}</span>{/if}
</div>

<style>
  .digital {
    font-family: var(--db-font-display);
    color: var(--db-fg);
    text-align: center;
  }
  time {
    font-size: 2.5em;
    font-variant-numeric: tabular-nums;
  }
  .label {
    display: block;
    color: var(--db-muted);
  }
</style>
