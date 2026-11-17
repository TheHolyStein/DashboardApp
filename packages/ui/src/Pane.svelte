<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import { useT } from './context.js';

  let { title, onClose, children }: { title: string; onClose: () => void; children?: Snippet | undefined } = $props();

  const t = useT();
  const uid = $props.id();
  const titleId = `pane-title-${uid}`;
  const FULLSCREEN_BELOW_PX = 700;

  let dialog = $state<HTMLDialogElement | null>(null);
  let full = $state(typeof window !== 'undefined' && window.innerWidth < FULLSCREEN_BELOW_PX);
  let closing = false;

  function requestClose(): void {
    if (closing) return;
    closing = true;
    onClose();
  }

  onMount(() => {
    const el = dialog;
    if (!el) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A modal dialog traps focus and inerts the rest of the page.
    if (!el.open) el.showModal();
    const onResize = (): void => {
      full = window.innerWidth < FULLSCREEN_BELOW_PX;
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (el.open) el.close();
      if (previous?.isConnected) previous.focus();
    };
  });
</script>

<dialog
  bind:this={dialog}
  class="pane"
  class:full
  aria-labelledby={titleId}
  oncancel={(e) => {
    e.preventDefault();
    requestClose();
  }}
  onclick={(e) => {
    if (e.target === dialog) requestClose();
  }}
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      requestClose();
    }
  }}
>
  <div class="inner">
    <header class="bar">
      <h2 id={titleId} class="title">{title}</h2>
      <button type="button" class="close" aria-label={t('pane.close', 'Close')} onclick={requestClose}>
<span aria-hidden="true">✕</span>
      </button>
    </header>
    <div class="content">{@render children?.()}</div>
  </div>
</dialog>

<style>
  .pane {
    box-sizing: border-box; width: min(960px, calc(100vw - 2rem)); max-width: 960px; max-height: 90vh; padding: 0; margin: auto;
    color: var(--db-fg, #15181d); background: var(--db-surface, #fff); border: var(--db-border, 1px solid #c9ced6);
    border-radius: var(--db-radius, 8px); overflow: hidden;
    animation: pane-in 150ms ease-out;
  }
  .pane.full { width: 100vw; max-width: none; height: 100dvh; max-height: none; border-radius: 0; border: 0; }
  .pane::backdrop { background: rgba(0, 0, 0, 0.5); }
  .inner { display: flex; flex-direction: column; max-height: inherit; height: 100%; }
  .bar { display: flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1rem; border-bottom: var(--db-border, 1px solid #c9ced6); }
  .title { flex: 1; margin: 0; font-size: 1.1rem; }
  .content { flex: 1; min-height: 0; padding: 1rem; overflow: auto; }
  .close { padding: 0.25rem 0.5rem; font: inherit; color: inherit; background: transparent; border: 0; border-radius: var(--db-radius, 8px); cursor: pointer; }
  .close:focus-visible { outline: 2px solid var(--db-focus, #1d4ed8); outline-offset: 2px; }
  @keyframes pane-in { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .pane { animation: none; } }
</style>
