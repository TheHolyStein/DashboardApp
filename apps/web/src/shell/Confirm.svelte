<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '@dash/ui';
  import { t } from '../lib/i18n.js';

  let {
    title,
    message,
    confirmLabel,
    busy = false,
    onConfirm,
    onCancel,
  }: { title: string; message: string; confirmLabel: string; busy?: boolean; onConfirm: () => void; onCancel: () => void } = $props();

  const uid = $props.id();
  let dialog = $state<HTMLDialogElement | null>(null);

  onMount(() => {
    const el = dialog;
    if (!el) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el.open) el.showModal();
    return () => {
      if (el.open) el.close();
      if (previous?.isConnected) previous.focus();
      // The opener is gone after a confirmed delete: once the DOM settled, move focus to a stable target.
      queueMicrotask(() => {
        const a = document.activeElement;
        if (a && a !== document.body && a.isConnected && !el.contains(a)) return;
        document.querySelector<HTMLElement>('[data-focus-fallback]')?.focus();
      });
    };
  });
</script>

<dialog
  bind:this={dialog}
  class="confirm"
  aria-labelledby={`${uid}-title`}
  aria-describedby={`${uid}-msg`}
  oncancel={(e) => {
    e.preventDefault();
    onCancel();
  }}
  onkeydown={(e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }}
>
  <h2 id={`${uid}-title`}>{title}</h2>
  <p id={`${uid}-msg`}>{message}</p>
  <div class="row">
    <Button onclick={onCancel}>{t('confirm.cancel', 'Cancel')}</Button>
    <Button variant="danger" data-edit disabled={busy} onclick={onConfirm}>{confirmLabel}</Button>
  </div>
</dialog>

<style>
  .confirm {
    max-width: min(24rem, calc(100vw - 2rem)); padding: 1rem; margin: auto; color: var(--db-fg, #15181d);
    background: var(--db-surface, #fff); border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px);
  }
  .confirm::backdrop { background: var(--db-backdrop, rgba(0, 0, 0, 0.5)); }
  h2 { margin: 0 0 0.5rem; font-size: 1.1rem; }
  p { margin: 0 0 1rem; }
  .row { display: flex; gap: 0.5rem; justify-content: flex-end; }
</style>
