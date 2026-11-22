<script lang="ts">
  import { useT } from './context.js';

  let { text }: { text?: string | undefined } = $props();
  const t = useT();
</script>

<span class="stale" data-stale="true">{text ?? t('stale.label', 'Stale')}</span>

<style>
  .stale {
    display: inline-block; padding: 0 0.5em; border-radius: 999px; font-size: 0.75em; font-weight: 600;
    color: var(--db-fg); background: var(--db-surface); border: 1px solid var(--db-warn); box-shadow: inset 3px 0 0 var(--db-warn);
  }
</style>
