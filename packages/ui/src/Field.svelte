<script lang="ts">
  import type { Snippet } from 'svelte';

  /** The children snippet may take `{ describedBy, invalid }` to set `aria-describedby`/`aria-invalid` on its control. */
  let {
    label,
    help,
    error,
    children,
  }: {
    label: string;
    help?: string;
    error?: string;
    children: Snippet<[{ describedBy: string | undefined; invalid: boolean }]>;
  } = $props();

  const uid = $props.id();
  const helpId = `${uid}-help`;
  const errorId = `${uid}-error`;
  const describedBy = $derived([error ? errorId : null, help ? helpId : null].filter(Boolean).join(' ') || undefined);
</script>

<div class="field">
  <!-- The label wraps the control, so they are bound without ids. -->
  <label>
    <span class="label">{label}</span>
    {@render children({ describedBy, invalid: !!error })}
  </label>
  {#if help}<p class="help" id={helpId}>{help}</p>{/if}
  {#if error}<p class="error" id={errorId} role="alert">{error}</p>{/if}
</div>

<style>
  .field { display: grid; gap: 0.25rem; margin-bottom: var(--db-gap, 8px); }
  label { display: grid; gap: 0.25rem; }
  .label { font-weight: 600; color: var(--db-fg, #15181d); }
  .help { margin: 0; font-size: 0.85em; color: var(--db-muted, #4a5260); }
  .error { margin: 0; font-size: 0.85em; color: var(--db-fg); border-left: 3px solid var(--db-crit); padding-left: 0.5em; }
</style>
