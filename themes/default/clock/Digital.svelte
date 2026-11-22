<script lang="ts">
  import type { ClockFaceProps } from '@dash/contract';

  let { now, size, showSeconds, hour12, timeZone, label }: ClockFaceProps = $props();

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

<div class="digital" class:big={size.w >= 4 && size.h >= 3}>
  <time datetime={now.toISOString()}>{text}</time>
  {#if label}<span class="label">{label}</span>{/if}
</div>

<style>
  .digital {
    font-family: var(--db-font-display);
    color: var(--db-fg);
    text-align: center;
    container-type: inline-size;
  }
  time {
    display: block;
    font-size: clamp(1.25rem, 18cqw, 3rem);
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }
  .big time {
    font-size: clamp(2rem, 22cqw, 6rem);
  }
  .label {
    display: block;
    color: var(--db-muted);
  }
</style>
