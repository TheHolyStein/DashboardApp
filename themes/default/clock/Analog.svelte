<script lang="ts">
  import type { ClockFaceProps } from '@dash/contract';

  let { now, showSeconds, timeZone, label }: ClockFaceProps = $props();

  // Wall-clock parts in the requested zone; the face is a pure function of its props.
  const parts = $derived.by(() => {
    const f = new Intl.DateTimeFormat('en-GB', {
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
      timeZone,
    }).formatToParts(now);
    const get = (t: string): number => Number(f.find((p) => p.type === t)?.value ?? 0);
    return { h: get('hour') % 12, m: get('minute'), s: get('second') };
  });
  const hourDeg = $derived((parts.h + parts.m / 60) * 30);
  const minuteDeg = $derived((parts.m + parts.s / 60) * 6);
  const secondDeg = $derived(parts.s * 6);
  const ticks = Array.from({ length: 12 }, (_, i) => i * 30);
</script>

<div class="analog">
  <svg viewBox="-50 -50 100 100" role="img" aria-label={label ?? 'Analog clock'}>
    <circle r="47" class="face" />
    {#each ticks as deg (deg)}
      <line x1="0" y1="-41" x2="0" y2={deg % 90 === 0 ? -36 : -38.5} transform={`rotate(${deg})`} class="tick" />
    {/each}
    <line x1="0" y1="3" x2="0" y2="-24" transform={`rotate(${hourDeg})`} class="hand hour" />
    <line x1="0" y1="4" x2="0" y2="-35" transform={`rotate(${minuteDeg})`} class="hand minute" />
    {#if showSeconds}
      <line x1="0" y1="8" x2="0" y2="-38" transform={`rotate(${secondDeg})`} class="hand second" />
    {/if}
    <circle r="2" class="pin" />
  </svg>
  {#if label}<span class="label">{label}</span>{/if}
</div>

<style>
  .analog {
    display: flex;
    flex-direction: column;
    align-items: center;
    height: 100%;
    color: var(--db-fg);
  }
  svg {
    flex: 1;
    min-height: 0;
    max-width: 100%;
    aspect-ratio: 1;
  }
  .face {
    fill: none;
    stroke: var(--db-border-color);
    stroke-width: 1.5;
  }
  .tick {
    stroke: var(--db-muted);
    stroke-width: 1.5;
    stroke-linecap: round;
  }
  .hand {
    stroke: var(--db-fg);
    stroke-linecap: round;
  }
  .hour {
    stroke-width: 3.5;
  }
  .minute {
    stroke-width: 2.5;
  }
  .second {
    stroke: var(--db-accent);
    stroke-width: 1;
  }
  .pin {
    fill: var(--db-accent);
  }
  .label {
    color: var(--db-muted);
    font-family: var(--db-font-body);
  }
</style>
