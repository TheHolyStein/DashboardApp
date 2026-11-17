<script lang="ts">
  import type { ClockFaceProps } from '@dash/contract';
  let { label }: ClockFaceProps = $props();
</script>

<!-- An image-like face with a label but no time as text. -->
<svg viewBox="0 0 10 10" role="img" aria-label={label ?? 'Clock'}><circle r="4" cx="5" cy="5" /></svg>
