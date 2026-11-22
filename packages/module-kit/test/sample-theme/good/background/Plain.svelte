<script lang="ts">
  import type { BackgroundProps } from '@dash/contract';

  let { mode }: BackgroundProps = $props();
</script>

<div class="plain" data-mode={mode} aria-hidden="true"></div>

<style>
  .plain {
    position: absolute;
    inset: 0;
    background: var(--db-bg);
  }
</style>
