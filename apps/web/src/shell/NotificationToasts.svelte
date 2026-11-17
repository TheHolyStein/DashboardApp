<script lang="ts">
  import { t } from '../lib/i18n.js';
  import { notifications } from '../lib/notifications.svelte.js';

  let { store = notifications }: { store?: typeof notifications } = $props();

  const critical = $derived(store.toasts.filter((x) => x.notification.level === 'critical'));
  const others = $derived(store.toasts.filter((x) => x.notification.level !== 'critical'));
</script>

<!-- Two live regions that are always present: critical ones interrupt (alert), the rest are polite (status). -->
<div class="toasts">
  <div role="alert" class="region">
    {#each critical as toast (toast.key)}
      <div class="toast crit">
        <span><strong>{toast.notification.title}</strong>{#if toast.notification.body} {toast.notification.body}{/if}</span>
        <button type="button" aria-label={t('notifications.dismiss', 'Dismiss')} onclick={() => store.dismissToast(toast.key)}>✕</button>
      </div>
    {/each}
  </div>
  <div role="status" class="region">
    {#each others as toast (toast.key)}
      <div class="toast">
        <span><strong>{toast.notification.title}</strong>{#if toast.notification.body} {toast.notification.body}{/if}</span>
        <button type="button" aria-label={t('notifications.dismiss', 'Dismiss')} onclick={() => store.dismissToast(toast.key)}>✕</button>
      </div>
    {/each}
  </div>
</div>

<style>
  .toasts { position: fixed; z-index: 30; right: 1rem; bottom: 1rem; display: grid; gap: 0.5rem; width: min(22rem, calc(100vw - 2rem)); pointer-events: none; }
  .region { display: grid; gap: 0.5rem; }
  .toast {
    display: flex; gap: 0.5rem; justify-content: space-between; align-items: flex-start; padding: 0.6rem 0.75rem; pointer-events: auto;
    color: var(--db-fg, #15181d); background: var(--db-surface, #fff); border: var(--db-border, 1px solid #c9ced6);
    border-radius: var(--db-radius, 8px); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.2); overflow-wrap: anywhere;
  }
  .crit { border-color: var(--db-crit, #b3261e); }
  button { font: inherit; color: inherit; background: transparent; border: 0; cursor: pointer; padding: 0 0.25rem; }
</style>
