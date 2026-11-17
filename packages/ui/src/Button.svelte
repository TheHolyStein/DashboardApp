<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  type Props = Omit<HTMLButtonAttributes, 'children'> & {
    variant?: 'primary' | 'ghost' | 'danger';
    children?: Snippet;
  };
  // `rest` carries data-edit, aria-* and any other native attribute.
  let { variant = 'ghost', type = 'button', disabled, onclick, children, ...rest }: Props = $props();
</script>

<button class="btn {variant}" {type} {disabled} {onclick} {...rest}>{@render children?.()}</button>

<style>
  .btn {
    font: inherit; padding: 0.45rem 0.9rem; border-radius: var(--db-radius, 8px); cursor: pointer;
    border: var(--db-border, 1px solid #c9ced6); color: var(--db-fg, #15181d); background: transparent;
    transition: background-color 120ms ease;
  }
  /* No accent or danger fill: the label colour is only guaranteed on the surface, so the variant shows in the border. */
  .primary { background: var(--db-surface); border: 2px solid var(--db-accent); color: var(--db-fg); }
  .danger { background: var(--db-surface); border: 2px solid var(--db-crit); color: var(--db-fg); }
  .ghost:hover:not(:disabled) { background: var(--db-surface-2, #eef0f4); }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn:focus-visible { outline: 2px solid var(--db-focus, #1d4ed8); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { .btn { transition: none; } }
</style>
