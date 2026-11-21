<script lang="ts">
  // Notifications detail: history grouped by day, filters, mark read and a mute menu per module. Reading state and
  // mutes are the user's own, so these controls are available at level `view` (no `data-edit`). On a shared page
  // (`isOwner` false) the routes would answer for the viewer, so only the owner's snapshot is shown, read-only.
  import { untrack } from 'svelte';
  import type { DetailProps } from '@dash/contract';
  import { Button, Empty } from '@dash/ui';
  import type { ListPage, MutesState, NotificationItem, Snapshot } from '../manifest.js';
  import { formatClock, formatDateTime, formatDay, groupByDay, levelClass, levelName } from './format.js';

  let { data, isOwner, api, t, locale, timeZone, close }: DetailProps<Snapshot> = $props();

  let items = $state.raw<NotificationItem[]>([]);
  let next = $state<string | null>(null);
  let loaded = $state(false);
  let mutes = $state.raw<Record<string, string>>({});
  let error = $state('');
  let moduleFilter = $state('');
  let levelFilter = $state('');
  let unreadOnly = $state(false);
  let marking = $state(false);
  /** Every module seen so far, so a filter that narrows the list never removes its own menu entry. */
  let known = $state.raw<string[]>([]);

  // Ordering: the newest `{ epoch, rev }` seen so far. A new epoch always wins; within one epoch an older answer is dropped.
  let heldList = { epoch: '', rev: -1 };
  let heldMutes = { epoch: '', rev: -1 };
  let token = 0; // a newer request makes older answers irrelevant (filters change faster than the network)

  const fresh = (held: { epoch: string; rev: number }, got: { epoch: string; rev: number }): boolean =>
    got.epoch !== held.epoch || got.rev >= held.rev;

  function remember(ids: string[]): void {
    const merged = [...new Set([...known, ...ids])].sort();
    if (merged.length !== known.length) known = merged;
  }

  async function fetchPage(more: boolean): Promise<void> {
    const mine = ++token;
    const query: Record<string, string> = {};
    if (moduleFilter) query['moduleId'] = moduleFilter;
    if (unreadOnly) query['unreadOnly'] = 'true';
    if (more && next) query['before'] = next;
    try {
      const answer = await api.get<ListPage>('/list', query);
      if (mine !== token || !fresh(heldList, answer)) return;
      heldList = { epoch: answer.epoch, rev: answer.rev };
      items = more ? [...items, ...answer.items] : answer.items;
      next = answer.next;
      loaded = true;
      error = '';
      remember(answer.items.map((n) => n.moduleId));
    } catch {
      if (mine === token) {
        loaded = true;
        error = t('m.notifications.loadFailed', 'Could not load your notifications.');
      }
    }
  }

  function applyMutes(answer: MutesState): void {
    if (!fresh(heldMutes, answer)) return;
    heldMutes = { epoch: answer.epoch, rev: answer.rev };
    mutes = answer.mutes;
    remember(Object.keys(answer.mutes));
  }

  async function fetchMutes(): Promise<void> {
    try {
      applyMutes(await api.get<MutesState>('/mutes'));
    } catch {
      error = t('m.notifications.loadFailed', 'Could not load your notifications.');
    }
  }

  // Loads when the pane opens, when a filter changes, and again whenever the snapshot moves on (a push means something changed).
  $effect(() => {
    void data?.epoch;
    void data?.rev;
    void moduleFilter;
    void unreadOnly;
    if (!isOwner) return;
    untrack(() => void fetchPage(false));
  });
  $effect(() => {
    void data?.epoch;
    void data?.rev;
    if (!isOwner) return;
    untrack(() => void fetchMutes());
  });

  const visible = $derived(items.filter((n) => !levelFilter || n.level === levelFilter));
  const groups = $derived(groupByDay(visible, timeZone));
  const hasUnread = $derived(items.some((n) => n.readAt === null));

  /** The words of a notification: translated through its key when it has one, else as sent. */
  const titleOf = (n: NotificationItem): string => (n.titleKey ? t(n.titleKey, n.title, n.vars ?? undefined) : n.title);

  async function markRead(ids: string[] | 'all'): Promise<void> {
    if (marking) return;
    marking = true;
    error = '';
    try {
      await api.post('/read', { ids });
      const at = new Date().toISOString();
      items = items.map((n) => (n.readAt === null && (ids === 'all' || ids.includes(n.id)) ? { ...n, readAt: at } : n));
    } catch {
      error = t('m.notifications.saveFailed', 'Could not save your change.');
    } finally {
      marking = false;
    }
  }

  // Mute menu ---------------------------------------------------------------------------------------
  const HOURS: Record<string, number> = { '1h': 1, '8h': 8, '24h': 24 };
  const choiceOf = (moduleId: string): string => {
    const until = mutes[moduleId];
    return until === undefined ? 'off' : until === 'forever' ? 'forever' : 'timed';
  };

  async function setMute(moduleId: string, choice: string, el: HTMLSelectElement): Promise<void> {
    if (choice === 'timed') return;
    const hours = HOURS[choice];
    const until = choice === 'off' ? null : choice === 'forever' ? 'forever' : new Date(new Date().getTime() + (hours ?? 1) * 3_600_000).toISOString();
    error = '';
    try {
      applyMutes(await api.put<MutesState>('/mutes', { moduleId, until }));
    } catch {
      error = t('m.notifications.saveFailed', 'Could not save your change.');
      el.value = choiceOf(moduleId);
    }
  }
</script>

<div class="notifications-detail">
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if !isOwner}
    <section aria-labelledby="notif-latest">
      <h3 id="notif-latest">{t('m.notifications.latest', 'Latest')}</h3>
      {#if data && data.latest.length > 0}
        <ul class="rows">
          {#each data.latest as n (n.id)}
            <li class={levelClass(n.level)}>
              <span class="level">{levelName(n.level, t)}</span>
              <span class="title" data-user>{n.title}</span>
              <span class="module" data-value>{n.moduleId}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <Empty text={t('m.notifications.allRead', 'All caught up')} />
      {/if}
    </section>
  {:else}
    <section aria-labelledby="notif-history">
      <h3 id="notif-history">{t('m.notifications.history', 'Notifications')}</h3>

      <div class="filters">
        <label>
          <span>{t('m.notifications.filter.module', 'Module')}</span>
          <select bind:value={moduleFilter}>
            <option value="">{t('m.notifications.filter.allModules', 'All modules')}</option>
            {#each known as id (id)}<option value={id}>{id}</option>{/each}
          </select>
        </label>
        <label>
          <span>{t('m.notifications.filter.level', 'Level')}</span>
          <select bind:value={levelFilter}>
            <option value="">{t('m.notifications.filter.allLevels', 'All levels')}</option>
            <option value="info">{levelName('info', t)}</option>
            <option value="warn">{levelName('warn', t)}</option>
            <option value="critical">{levelName('critical', t)}</option>
          </select>
        </label>
        <label class="check">
          <input type="checkbox" bind:checked={unreadOnly} />
          <span>{t('m.notifications.filter.unreadOnly', 'Unread only')}</span>
        </label>
        <Button busy={marking} disabled={!hasUnread} onclick={() => void markRead('all')}>
          {t('m.notifications.markAllRead', 'Mark all read')}
        </Button>
      </div>

      {#if !loaded}
        <p class="muted" aria-busy="true">{t('m.notifications.loading', 'Loading…')}</p>
      {:else if groups.length === 0}
        <Empty text={t('m.notifications.empty', 'No notifications.')} />
      {:else}
        {#each groups as group (group.key)}
          <h4>{formatDay(group.key, locale)}</h4>
          <ul class="rows">
            {#each group.items as n (n.id)}
              <li class={levelClass(n.level)} class:read={n.readAt !== null}>
                <span class="level">{levelName(n.level, t)}</span>
                <span class="title" data-user>{titleOf(n)}</span>
                <span class="module" data-value>{n.moduleId}</span>
                <time class="time" datetime={n.createdAt} data-value>{formatClock(n.createdAt, locale, timeZone)}</time>
                {#if n.readAt === null}
                  <Button busy={marking} onclick={() => void markRead([n.id])}>{t('m.notifications.markRead', 'Mark read')}</Button>
                {/if}
              </li>
            {/each}
          </ul>
        {/each}
        {#if next}
          <Button onclick={() => void fetchPage(true)}>{t('m.notifications.loadMore', 'Load more')}</Button>
        {/if}
      {/if}
    </section>

    <section aria-labelledby="notif-mutes">
      <h3 id="notif-mutes">{t('m.notifications.mutes', 'Mute a module')}</h3>
      {#if known.length === 0}
        <Empty text={t('m.notifications.noModules', 'No module has sent you a notification yet.')} />
      {:else}
        <ul class="rows">
          {#each known as id (id)}
            <li>
              <span class="module" data-value>{id}</span>
              <select
                aria-label={t('m.notifications.muteModule', 'Mute {module}', { module: id })}
                value={choiceOf(id)}
                onchange={(e) => void setMute(id, e.currentTarget.value, e.currentTarget)}
              >
                <option value="off">{t('m.notifications.mute.off', 'Not muted')}</option>
                <option value="1h">{t('m.notifications.mute.1h', 'Mute for 1 hour')}</option>
                <option value="8h">{t('m.notifications.mute.8h', 'Mute for 8 hours')}</option>
                <option value="24h">{t('m.notifications.mute.24h', 'Mute for 24 hours')}</option>
                <option value="forever">{t('m.notifications.mute.forever', 'Mute for ever')}</option>
                {#if choiceOf(id) === 'timed'}
                  <option value="timed" disabled>
                    {t('m.notifications.mute.until', 'Muted until {time}', { time: formatDateTime(mutes[id] ?? '', locale, timeZone) })}
                  </option>
                {/if}
              </select>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}

  <Button onclick={() => close()}>{t('m.notifications.close', 'Close')}</Button>
</div>

<style>
  .notifications-detail {
    display: grid;
    gap: var(--db-gap, 12px);
    color: var(--db-fg);
  }
  h3,
  h4,
  p,
  ul {
    margin: 0;
    padding: 0;
  }
  h3,
  h4 {
    font-family: var(--db-font-heading);
  }
  h4 {
    margin-top: 0.75rem;
    color: var(--db-muted);
  }
  .filters {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 0.5rem 1rem;
  }
  .filters label {
    display: grid;
    gap: 0.25rem;
  }
  .filters label.check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .rows {
    display: grid;
    gap: 0.25rem;
    list-style: none;
  }
  .rows li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 0.75rem;
    border-inline-start: 4px solid var(--db-accent);
    padding-inline-start: 0.5rem;
  }
  .rows li.warn {
    border-inline-start-color: var(--db-warn);
  }
  .rows li.critical {
    border-inline-start-color: var(--db-crit);
  }
  .rows li.read .title {
    font-weight: normal;
    color: var(--db-muted);
  }
  .title {
    font-weight: 600;
  }
  .muted,
  .level,
  .module,
  .time {
    color: var(--db-muted);
  }
  .time {
    font-variant-numeric: tabular-nums;
  }
  select:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--db-focus);
    outline-offset: 2px;
  }
  .error {
    border-inline-start: 4px solid var(--db-crit);
    padding-inline-start: 0.5rem;
  }
</style>
