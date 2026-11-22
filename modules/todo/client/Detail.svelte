<script lang="ts">
  // Todo detail: one tab per list, add/edit/delete, drag (or button) reordering, clear done and the shopping store mode.
  // Controls that change data carry `data-edit` and exist only at level edit for the owner of the instance. On a shared
  // page (`isOwner` false) the owner's snapshot is all there is: no caller-scoped routes are called.
  import { onMount, tick, untrack } from 'svelte';
  import { DashError, type DetailProps } from '@dash/contract';
  import { Button, Empty, serial } from '@dash/ui';
  import type { ItemList, Settings, Snapshot, TodoListId, WireItem } from '../manifest.js';
  import ItemEditor from './ItemEditor.svelte';
  import ItemRow from './ItemRow.svelte';
  import { conflictItem, inOrder, isGone, LIST_ORDER, newer, rowOf, withItem, type EditorValues, type Row } from './model.js';
  import StoreMode from './StoreMode.svelte';

  let { data, settings, level, isOwner, api, t, locale, timeZone, params }: DetailProps<Snapshot, Settings> = $props();

  type User = { id: string; name: string; handle: string };

  const canEdit = $derived(level === 'edit' && isOwner);
  const lists = $derived(LIST_ORDER.filter((l) => settings.lists.length === 0 || settings.lists.includes(l)));
  let tab = $state<TodoListId>(untrack(() => LIST_ORDER.find((l) => l === params['list']) ?? lists[0] ?? 'week'));

  // The one source of truth for the owner's items: only data at least as new as what is held replaces it.
  let held = $state.raw<ItemList | null>(null);
  let users = $state.raw<User[]>([]);
  let loaded = $state(false);
  let error = $state('');
  let hint = $state('');
  let editing = $state<{ item: WireItem | null } | null>(null);
  /** The current server version of the item being edited, after a 409 (the editor stays open with the user's input). */
  let conflict = $state.raw<WireItem | null>(null);
  let saving = $state(false);
  let storeMode = $state(false);
  let busyIds = $state<Record<string, boolean>>({});
  /** Done state shown before the server confirmed it (store mode taps). */
  let overrides = $state<Record<string, boolean>>({});
  let dragId: string | null = null;
  let addWrap = $state<HTMLElement>();

  const names = $derived(new Map(users.map((u) => [u.id, u.name])));
  const byId = $derived(new Map((held?.items ?? []).map((i) => [i.id, i])));

  const apply = (incoming: ItemList): void => {
    held = newer(held, incoming);
  };

  const listLabel = (l: TodoListId): string => {
    switch (l) {
      case 'week': return t('m.todo.list.week', 'Week');
      case 'month': return t('m.todo.list.month', 'Month');
      case 'deadline': return t('m.todo.list.deadline', 'Deadline');
      case 'shopping': return t('m.todo.list.shopping', 'Shopping');
      default: return t('m.todo.list.chores', 'Chores');
    }
  };

  const failure = (err: unknown): string =>
    err instanceof DashError && err.code === 'invalid' && err.message ? err.message : t('m.todo.saveFailed', 'Could not save your change.');

  type Outcome = { ok: boolean; conflict: WireItem | null; gone: boolean };
  const CHANGED = (): string => t('m.todo.conflict', 'Someone else changed this item. It has been refreshed.');

  /**
   * A 409 carries the current item: show it and say so. A 404 means somebody deleted the item: reload the list and say
   * so too. Anything else is an error line.
   */
  function handleError(err: unknown): Outcome {
    const current = conflictItem(err);
    if (current && held) {
      held = withItem(held, current);
      hint = CHANGED();
      return { ok: false, conflict: current, gone: false };
    }
    if (isGone(err)) {
      hint = CHANGED();
      load();
      return { ok: false, conflict: null, gone: true };
    }
    error = failure(err);
    return { ok: false, conflict: null, gone: false };
  }

  // Calls run one after another, each against the list the previous one produced.
  const send = serial(async (call: () => Promise<ItemList>): Promise<Outcome> => {
    try {
      apply(await call());
      return { ok: true, conflict: null, gone: false };
    } catch (err) {
      return handleError(err);
    }
  });

  function reset(): void {
    error = '';
    hint = '';
    conflict = null;
  }

  function load(): void {
    api.get<ItemList>('/items').then(
      (list) => {
        apply(list);
        loaded = true;
      },
      () => {
        loaded = true;
        error = t('m.todo.loadFailed', 'Could not load the list.');
      },
    );
  }

  onMount(() => {
    if (!isOwner) return;
    load();
    api.get<User[]>('/users').then(
      (u) => (users = u),
      () => (error = t('m.todo.loadFailed', 'Could not load the list.')),
    );
    // Pushes may have been missed while the page was hidden.
    const onVisible = (): void => {
      if (!document.hidden) load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });

  /** The rows of the current tab: open ones in the caller's own order, then the done ones. */
  const rows = $derived.by((): Row[] => {
    if (!isOwner) {
      return (data?.items ?? []).filter((i) => i.list === tab).map((i) => ({
        id: i.id, title: i.title, icon: i.icon, qty: null, note: null, due: i.due, done: i.done, version: i.version,
        assigneeName: i.assigneeName, fromCalendar: false, overdue: false,
      }));
    }
    const me = held?.userId;
    const mine = (settings.show === 'all' ? held?.items : held?.items.filter((i) => i.assigneeId === null || i.assigneeId === me)) ?? [];
    const inTab = mine.filter((i) => i.list === tab);
    const open = inOrder(inTab.filter((i) => !i.done), held?.order[tab]);
    const done = inTab.filter((i) => i.done);
    return [...open, ...done].map((i) => {
      const row = rowOf(i, names);
      return { ...row, done: overrides[i.id] ?? row.done };
    });
  });
  const hasDone = $derived(rows.some((r) => r.done));
  const openIds = $derived(rows.filter((r) => !r.done).map((r) => r.id));

  async function toggle(row: Row): Promise<void> {
    if (busyIds[row.id]) return;
    reset();
    busyIds[row.id] = true;
    overrides[row.id] = !row.done;
    try {
      await send(() => api.post<ItemList>(`/items/${row.id}/done`, { version: row.version, done: !row.done }));
    } finally {
      delete overrides[row.id];
      delete busyIds[row.id];
    }
  }

  async function saveOrder(ids: string[]): Promise<void> {
    if (held) held = { ...held, order: { ...held.order, [tab]: ids } };
    reset();
    await send(() => api.put<ItemList>('/order', { list: tab, ids }));
  }
  function move(row: Row, delta: -1 | 1): void {
    const ids = [...openIds];
    const from = ids.indexOf(row.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    void saveOrder(ids);
  }
  function dropOn(target: Row): void {
    const id = dragId;
    dragId = null;
    if (!id || id === target.id) return;
    const ids = openIds.filter((x) => x !== id);
    const at = ids.indexOf(target.id);
    if (at < 0) return;
    ids.splice(at, 0, id);
    void saveOrder(ids);
  }

  async function closeEditor(): Promise<void> {
    editing = null;
    await tick();
    addWrap?.querySelector('button')?.focus();
  }

  async function save(values: EditorValues): Promise<void> {
    if (!editing || saving) return;
    const item = editing.item;
    saving = true;
    reset();
    const { due, ...rest } = values;
    const fields = { ...rest, ...(due === undefined ? {} : { due }) };
    try {
      const res = await send(() =>
        item
          ? api.patch<ItemList>(`/items/${item.id}`, { version: item.version, ...fields })
          : api.post<ItemList>('/items', { list: tab, ...fields }),
      );
      await afterEdit(res);
    } finally {
      saving = false;
    }
  }

  async function remove(): Promise<void> {
    const item = editing?.item;
    if (!item || saving) return;
    saving = true;
    reset();
    try {
      const res = await send(() => api.delete<ItemList>(`/items/${item.id}?version=${item.version}`));
      await afterEdit(res);
    } finally {
      saving = false;
    }
  }

  /** Done and gone close the editor. A conflict keeps it open with what the user typed and shows the current values. */
  async function afterEdit(res: Outcome): Promise<void> {
    if (res.ok || res.gone) await closeEditor();
    else if (res.conflict) {
      editing = { item: res.conflict }; // the next save carries the current version: the user decides
      conflict = res.conflict;
    }
  }

  async function clearDone(): Promise<void> {
    reset();
    await send(() => api.post<ItemList>('/items/clear-done', { list: tab }));
  }
</script>

<div class="todo-detail">
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if hint}<p class="hint" role="status">{hint}</p>{/if}

  <div class="tabs" role="tablist" aria-label={t('m.todo.lists', 'Lists')}>
    {#each lists as l (l)}
      <button
        type="button"
        role="tab"
        id={`todo-tab-${l}`}
        class="tab"
        aria-selected={tab === l}
        aria-controls="todo-panel"
        onclick={() => {
          tab = l;
          editing = null;
          reset();
        }}
      >{listLabel(l)}</button>
    {/each}
  </div>

  <div id="todo-panel" role="tabpanel" aria-labelledby={`todo-tab-${tab}`}>
    {#if editing && canEdit}
      <ItemEditor
        item={editing.item}
        list={tab}
        {users}
        {t}
        {timeZone}
        {locale}
        current={conflict}
        busy={saving}
        {error}
        onsave={save}
        oncancel={closeEditor}
        {...editing.item ? { ondelete: remove } : {}}
      />
    {:else}
      {#if canEdit}
        <div class="toolbar">
          <span bind:this={addWrap}>
            <Button data-edit variant="primary" onclick={() => { reset(); editing = { item: null }; }}>{t('m.todo.addItem', 'Add item')}</Button>
          </span>
          {#if tab === 'shopping'}
            <Button data-edit onclick={() => (storeMode = true)}>{t('m.todo.storeMode', 'Store mode')}</Button>
          {/if}
          {#if hasDone}
            <Button data-edit onclick={clearDone}>{t('m.todo.clearDone', 'Clear done')}</Button>
          {/if}
        </div>
      {/if}
      {#if isOwner && !loaded}
        <p class="muted" aria-busy="true">{t('m.todo.loading', 'Loading…')}</p>
      {:else if rows.length === 0}
        <Empty text={t('m.todo.emptyList', 'Nothing here.')} />
      {:else}
        <ul class="rows">
          {#each rows as row (row.id)}
            <ItemRow
              {row}
              {t}
              {locale}
              {timeZone}
              {canEdit}
              full
              busy={busyIds[row.id] === true}
              ontoggle={toggle}
              onedit={(r) => { reset(); editing = { item: byId.get(r.id) ?? null }; }}
              onmove={move}
              ondragstart={(r) => (dragId = r.id)}
              ondrop={dropOn}
            />
          {/each}
        </ul>
      {/if}
    {/if}
  </div>

  {#if storeMode && canEdit}
    <StoreMode {rows} {t} onclose={() => (storeMode = false)} ontap={toggle} />
  {/if}
</div>

<style>
  .todo-detail { display: grid; gap: 0.75rem; color: var(--db-fg); }
  .tabs { display: flex; flex-wrap: wrap; gap: 0.25rem; border-bottom: var(--db-border, 1px solid #c9ced6); }
  .tab { font: inherit; padding: 0.5rem 0.9rem; color: var(--db-fg); background: transparent; border: 0; border-bottom: 3px solid transparent; cursor: pointer; }
  .tab[aria-selected='true'] { border-bottom-color: var(--db-accent); font-weight: 700; }
  .tab:focus-visible { outline: 2px solid var(--db-focus, #1d4ed8); outline-offset: -2px; }
  .toolbar { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem; }
  .rows { margin: 0; padding: 0; }
  .muted, .hint { margin: 0; color: var(--db-muted); }
  .error { margin: 0; border-left: 3px solid var(--db-crit); padding-left: 0.5em; }
</style>
