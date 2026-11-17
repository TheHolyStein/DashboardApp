<script lang="ts">
  import type { ClockFaceProps } from '@dash/contract';
  let { now, timeZone }: ClockFaceProps = $props();
  const text = $derived(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hourCycle: 'h23', timeZone }).format(now));
</script>

<svg viewBox="0 0 10 10" role="img" aria-label={text}><circle r="4" cx="5" cy="5" /></svg>
