<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { formatRelative } from '@dash/ui';
  import { clientModules } from '../generated/modules.js';
  import { detail } from '../lib/detail.svelte.js';
  import { t } from '../lib/i18n.js';
  import { isSafeAppUrl, notifications, type Notification } from '../lib/notifications.svelte.js';
  import { pages } from '../lib/pages.svelte.js';
  import { ticker } from '../lib/ticker.svelte.js';

  let {
    modules = clientModules,
    store = notifications,
  }: { modules?: Record<string, { manifest: { name: string } }>; store?: typeof notifications } = $props();

  let open = $state(false);
  let button = $state<HTMLButtonElement | null>(null);
  let root = $state<HTMLElement | null>(null);
  const panelId = $props.id();

  onMount(() => ticker.subscribe());

  const ICON = { info: 'ℹ', warn: '⚠', critical: '⛔' } as const;
  const LEVEL = {
    info: () => t('notifications.levelInfo', 'Information'),
    warn: () => t('notifications.levelWarn', 'Warning'),
    critical: () => t('notifications.levelCritical', 'Critical'),
  } as const;

  const moduleName = (id: string): string => {
    const m = Object.hasOwn(modules, id) ? modules[id] : undefined;
    return t(`module.${id}.name`, m?.manifest.name ?? id);
  };

  // "View all" needs the notifications module's own instance on one of the user's pages.
  const viewAll = $derived.by(() => {
    for (const p of pages.list) {
      const i = p.instances.find((x) => x.moduleId === 'notifications');
      if (i) return { pageId: p.id, instanceId: i.id };
    }
    return null;
  });

  function close(returnFocus = false): void {
    open = false;
    if (returnFocus) void tick().then(() => button?.focus());
  }

  function onKey(e: KeyboardEvent): void {
    if (open && e.key === 'Escape') {
      e.stopPropagation();
      close(true);
    }
  }
  function onDocClick(e: MouseEvent): void {
    if (open && root && e.target instanceof Node && !root.contains(e.target)) close();
  }

  function navigate(url: string): void {
    // Same-origin relative paths only (checked by the caller); the stores follow popstate.
    history.pushState(null, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }

  async function activate(n: Notification): Promise<void> {
    void store.markRead([n.id]);
    if (isSafeAppUrl(n.url)) {
      close();
      navigate(n.url);
    }
  }

  function showAll(): void {
    if (!viewAll) return;
    close();
    pages.select(viewAll.pageId);
    detail.open(viewAll.instanceId);
  }
</script>

<svelte:document onclick={onDocClick} />

<div class="notif" bind:this={root} onkeydown={onKey} role="presentation">
  <button
    bind:this={button}
    type="button"
    class="bell"
    aria-expanded={open}
    aria-controls={panelId}
    aria-haspopup="true"
    aria-label={store.unread > 0
      ? t('notifications.bellUnread', 'Notifications, {n} unread', { n: store.unread })
      : t('notifications.bell', 'Notifications')}
    onclick={() => (open = !open)}
  >
    <span aria-hidden="true">🔔</span>
    {#if store.unread > 0}<span class="badge" data-testid="unread-badge">{store.unread > 99 ? '99+' : store.unread}</span>{/if}
  </button>
  {#if open}
    <div class="panel" id={panelId} role="region" aria-label={t('notifications.title', 'Notifications')}>
      <div class="head">
        <strong>{t('notifications.title', 'Notifications')}</strong>
        <button type="button" class="link" disabled={store.unread === 0} onclick={() => void store.markRead('all')}>
          {t('notifications.markAll', 'Mark all read')}
        </button>
      </div>
      {#if store.items.length === 0}
        <p class="empty">{t('notifications.empty', 'No notifications')}</p>
      {:else}
        <ul>
          {#each store.items as n (n.id)}
            <li class:unread={n.readAt === null}>
              <button type="button" class="item" onclick={() => void activate(n)}>
                <span class="lvl" role="img" aria-label={LEVEL[n.level]()} data-level={n.level}>{ICON[n.level]}</span>
                <span class="txt">
                  <span class="title">{n.title}</span>
                  {#if n.body}<span class="body">{n.body}</span>{/if}
                  {#if n.url && !isSafeAppUrl(n.url)}<span class="body" data-testid="unsafe-url">{n.url}</span>{/if}
                  <span class="meta">{moduleName(n.moduleId)} · {formatRelative(n.createdAt, ticker.now, t)}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if viewAll}
        <div class="foot"><button type="button" class="link" onclick={showAll}>{t('notifications.viewAll', 'View all')}</button></div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .notif { position: relative; }
  .bell, .link, .item {
    font: inherit; color: var(--db-fg, #15181d); background: transparent; cursor: pointer;
  }
  .bell { position: relative; padding: 0.4rem 0.6rem; border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px); }
  .badge {
    position: absolute; top: -6px; right: -6px; min-width: 1.2rem; padding: 0 0.3rem; font-size: 0.75rem; line-height: 1.2rem;
    text-align: center; color: var(--db-on-accent, #fff); background: var(--db-crit, #b3261e); border-radius: 999px;
  }
  .panel {
    position: absolute; right: 0; top: calc(100% + 6px); z-index: 20; width: min(24rem, calc(100vw - 2rem)); max-height: 70vh; overflow: auto;
    color: var(--db-fg, #15181d); background: var(--db-surface, #fff); border: var(--db-border, 1px solid #c9ced6);
    border-radius: var(--db-radius, 8px); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.2);
  }
  .head, .foot { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.75rem; }
  .link { padding: 0.25rem 0.4rem; border: 0; text-decoration: underline; color: var(--db-accent, #1f5fd1); }
  .link:disabled { color: var(--db-muted, #4a5260); cursor: default; }
  ul { margin: 0; padding: 0; list-style: none; }
  li { border-top: var(--db-border, 1px solid #c9ced6); }
  li.unread { background: var(--db-surface-2, #eef0f4); }
  .item { display: flex; gap: 0.6rem; width: 100%; padding: 0.6rem 0.75rem; text-align: left; border: 0; }
  .txt { display: grid; gap: 0.15rem; min-width: 0; overflow-wrap: anywhere; }
  .title { font-weight: 600; }
  .body, .meta { font-size: 0.85em; color: var(--db-muted, #4a5260); }
  .empty { padding: 0.75rem; margin: 0; color: var(--db-muted, #4a5260); }
</style>
