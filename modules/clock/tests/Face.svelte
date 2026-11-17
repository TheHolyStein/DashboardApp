<script lang="ts">
  // Test double for a theme clock face: prints the props it receives.
  import type { ClockFaceProps } from '@dash/contract';

  let { now, timeZone, showSeconds, hour12, label }: ClockFaceProps = $props();
</script>

<div data-testid="face" data-seconds={showSeconds} data-hour12={hour12} data-label={label ?? ''}>{timeZone} {now.toISOString()}</div>
