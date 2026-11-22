<script lang="ts">
  // Todo tile: counts per bucket, the next items with checkboxes and a quick-add field. Needs-setup state: not
  // applicable, the module needs no configuration. Without `data` the tile shows a loading line.
  import { untrack } from 'svelte';
  import type { TileProps } from '@dash/contract';
  import { Button, Empty } from '@dash/ui';
  import type { Bucket, ItemList, Settings, Snapshot } from '../manifest.js';
  import { bucketer } from '../server/buckets.js';
  import ItemRow from './ItemRow.svelte';
  import { useMinute } from './minute.svelte.js';
  import { conflictItem, GROUPS, isGone, newer, parseQuickAdd, type Group, type Row } from './model.js';

  let { data: pushed, settings, level, isOwner, size, api, t, locale, timeZone }: TileProps<Snapshot, Settings> = $props();

  // A snapshot older than the one on screen (a late or reordered push) is ignored; a new server epoch always wins.
  let data = $state.raw<Snapshot | undefined>(untrack(() => pushed));
  $effect.pre(() => {
    const next = pushed;
    untrack(() => {
      if (next) data = newer(data ?? null, next);
    });
  });

  const canEdit = $derived(level === 'edit' && isOwner && (data?.canEdit ?? true));
  const ticker = useMinute();

  let text = $state('');
  let adding = $state(false);
  let error = $state('');
  let hint = $state('');
  /**
   * Ticks made here whose snapshot has not arrived yet: the row shows the new state at once. A mark goes when the item
   * in a pushed snapshot has changed (another version than the one ticked) or is gone, or, once the request has
   * settled, with the next snapshot. An unrelated snapshot that arrives while the request runs leaves it alone.
   */
  let pending = $state<Record<string, { done: boolean; version: number; settled: boolean }>>({});

  // Groups and counts are in the zone the snapshot was computed in (the owner's), not the viewer's.
  const zone = $derived(data?.timeZone ?? timeZone);
  const bucketOf = $derived(bucketer(ticker.now, zone));
  const groupOf = (item: Snapshot['items'][number]): Group => (item.done ? 'done' : (bucketOf(item) as Bucket));
  const rowOf = (item: Snapshot['items'][number]): Row => ({
    id: item.id,
    title: item.title,
    icon: item.icon,
    qty: null,
    note: null,
    due: item.due,
    done: pending[item.id]?.done ?? item.done,
    version: item.version,
    assigneeName: item.assigneeName,
    fromCalendar: false,
    overdue: !item.done && groupOf(item) === 'overdue',
  });

  const groups = $derived.by(() => {
    const items = data?.items ?? [];
    return GROUPS.map((g) => ({ group: g, rows: items.filter((i) => groupOf(i) === g).map(rowOf) })).filter((g) => g.rows.length > 0);
  });
  const flat = $derived((data?.items ?? []).map(rowOf));
  const roomy = $derived(size.h >= 3);
  const headerLabel = (g: Group): string => {
    switch (g) {
      case 'overdue': return t('m.todo.bucket.overdue', 'Overdue');
      case 'today': return t('m.todo.bucket.today', 'Today');
      case 'week': return t('m.todo.bucket.week', 'This week');
      case 'month': return t('m.todo.bucket.month', 'This month');
      case 'later': return t('m.todo.bucket.later', 'Later');
      case 'none': return t('m.todo.bucket.none', 'No date');
      default: return t('m.todo.bucket.done', 'Done');
    }
  };
  const countOf = (g: Group, shown: number): number => (g === 'done' ? shown : (data?.counts[g] ?? shown));
  /** New items go into the first list the tile shows. */
  const targetList = $derived(settings.lists[0] ?? 'week');

  // Reload the whole thing: the answer is the full list, the snapshot push follows with the new state.
  async function toggle(row: Row): Promise<void> {
    if (pending[row.id]?.settled === false) return;
    error = '';
    hint = '';
    const mark = { done: !row.done, version: row.version, settled: false };
    pending[row.id] = mark;
    try {
      await api.post<ItemList>(`/items/${row.id}/done`, { version: row.version, done: !row.done });
      const held = pending[row.id]; // the $state proxy of `mark`
      if (held) held.settled = true;
      prune(false);
    } catch (err) {
      delete pending[row.id];
      if (conflictItem(err) || isGone(err)) hint = t('m.todo.conflict', 'Someone else changed this item. It has been refreshed.');
      else error = t('m.todo.saveFailed', 'Could not save your change.');
    }
  }

  /** Drops the marks whose item changed or vanished in the snapshot on screen; `all` also drops the settled ones. */
  function prune(all: boolean): void {
    const items = new Map((data?.items ?? []).map((i) => [i.id, i]));
    for (const [id, mark] of Object.entries(pending)) {
      const item = items.get(id);
      if (!item || item.version !== mark.version || (all && mark.settled)) delete pending[id];
    }
  }

  // A pushed snapshot: marks of items that changed (or whose request has settled) are no longer needed.
  $effect(() => {
    void data;
    untrack(() => prune(true));
  });

  async function quickAdd(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (adding) return;
    const { title, handle } = parseQuickAdd(text);
    if (title === '') return;
    adding = true;
    error = '';
    try {
      await api.post<ItemList>('/items', { list: targetList, title, ...(handle ? { assigneeHandle: handle } : {}) });
      text = '';
    } catch {
      error = t('m.todo.addFailed', 'Could not add the item. Check the @name.');
    } finally {
      adding = false;
    }
  }
</script>

<div class="todo-tile">
  {#if !data}
    <p class="muted">{t('m.todo.loading', 'Loading…')}</p>
  {:else if flat.length === 0}
    <Empty text={t('m.todo.empty', 'Nothing to do.')} />
  {:else if !roomy}
    <ul class="rows">
      {#each flat.slice(0, 3) as row (row.id)}
        <ItemRow {row} {t} {locale} {timeZone} {canEdit} ontoggle={toggle} />
      {/each}
    </ul>
  {:else}
    {#each groups as g (g.group)}
      <section aria-labelledby={`todo-g-${g.group}`}>
        <h4 id={`todo-g-${g.group}`} class="head">
          {headerLabel(g.group)} <span class="count" data-value>{countOf(g.group, g.rows.length)}</span>
        </h4>
        <ul class="rows">
          {#each g.rows as row (row.id)}
            <ItemRow {row} {t} {locale} {timeZone} {canEdit} ontoggle={toggle} />
          {/each}
        </ul>
      </section>
    {/each}
  {/if}

  {#if hint}<p class="hint" role="status">{hint}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if canEdit && roomy}
    <form class="quick" onsubmit={quickAdd}>
      <input
        data-edit
        bind:value={text}
        maxlength="220"
        placeholder={t('m.todo.quickAdd', 'Add item, @name to assign')}
        aria-label={t('m.todo.quickAddLabel', 'Add an item')}
      />
      <Button data-edit type="submit" busy={adding}>{t('m.todo.add', 'Add')}</Button>
    </form>
  {/if}
</div>

<style>
  .todo-tile { container-type: inline-size; display: grid; align-content: start; gap: 0.5rem; width: 100%; height: 100%; overflow: auto; color: var(--db-fg); }
  .head { display: flex; align-items: baseline; gap: 0.5rem; margin: 0; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--db-muted); }
  .count { font-variant-numeric: tabular-nums; }
  .rows { margin: 0; padding: 0; }
  .muted, .hint { margin: 0; color: var(--db-muted); }
  .error { margin: 0; border-left: 3px solid var(--db-crit); padding-left: 0.5em; }
  .quick { display: flex; gap: 0.5rem; margin-top: auto; }
  .quick input { flex: 1; min-width: 0; font: inherit; padding: 0.4rem 0.6rem; color: var(--db-fg); background: var(--db-surface); border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px); }
  .quick input:focus-visible { outline: 2px solid var(--db-focus, #1d4ed8); outline-offset: 2px; }
</style>
