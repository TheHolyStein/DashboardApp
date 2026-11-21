<script lang="ts">
  // One item. Interactive parts carry `data-edit` and are only rendered when `canEdit` (level edit AND owner).
  import type { Translate } from '@dash/contract';
  import { Button, Icon } from '@dash/ui';
  import { formatDue } from './format.js';
  import { isIconKey, type Row } from './model.js';

  type Props = {
    row: Row;
    t: Translate;
    locale: string;
    timeZone: string;
    canEdit: boolean;
    busy?: boolean;
    /** Detail only: an edit button, drag handle and move buttons. */
    full?: boolean;
    ontoggle?: (row: Row) => void;
    onedit?: (row: Row) => void;
    onmove?: (row: Row, delta: -1 | 1) => void;
    ondragstart?: (row: Row) => void;
    ondrop?: (row: Row) => void;
  };
  let { row, t, locale, timeZone, canEdit, busy = false, full = false, ontoggle, onedit, onmove, ondragstart, ondrop }: Props = $props();

  const due = $derived(row.due ? formatDue(row.due, { locale, timeZone }) : '');
  const movable = $derived(full && canEdit && !row.done);
</script>

<li
  class="row"
  class:done={row.done}
  class:overdue={row.overdue}
  draggable={movable}
  ondragstart={movable ? () => ondragstart?.(row) : null}
  ondragover={movable ? (e) => e.preventDefault() : null}
  ondrop={movable ? (e) => { e.preventDefault(); ondrop?.(row); } : null}
  data-id={row.id}
>
  {#if canEdit}
    <input
      type="checkbox"
      class="check"
      data-edit
      checked={row.done}
      disabled={busy}
      aria-label={row.done ? t('m.todo.reopen', 'Mark as open: {title}', { title: row.title }) : t('m.todo.complete', 'Mark as done: {title}', { title: row.title })}
      onchange={() => ontoggle?.(row)}
    />
  {:else}
    <span class="mark" aria-hidden="true">{row.done ? '✓' : '○'}</span>
  {/if}
  {#if row.icon}
    <span class="icon" aria-hidden="true">
      {#if isIconKey(row.icon)}<Icon name={row.icon} size={16} />{:else}{row.icon}{/if}
    </span>
  {/if}
  <span class="body">
    <span class="title" data-user>{row.title}</span>
    {#if row.qty}<span class="qty" data-user>{row.qty}</span>{/if}
    {#if row.fromCalendar}<span class="chip">{t('m.todo.fromCalendar', 'Calendar')}</span>{/if}
    {#if due || row.assigneeName}
      <span class="meta">
        {#if due}<span class="due" data-value>{due}</span>{/if}
        {#if row.assigneeName}<span class="who" data-user>{row.assigneeName}</span>{/if}
      </span>
    {/if}
    {#if full && row.note}<span class="note" data-user>{row.note}</span>{/if}
  </span>
  {#if full && canEdit}
    <span class="tools">
      {#if movable}
        <Button data-edit aria-label={t('m.todo.moveUp', 'Move up: {title}', { title: row.title })} onclick={() => onmove?.(row, -1)}>↑</Button>
        <Button data-edit aria-label={t('m.todo.moveDown', 'Move down: {title}', { title: row.title })} onclick={() => onmove?.(row, 1)}>↓</Button>
      {/if}
      <Button data-edit aria-label={t('m.todo.edit', 'Edit: {title}', { title: row.title })} onclick={() => onedit?.(row)}>
        {t('m.todo.editShort', 'Edit')}
      </Button>
    </span>
  {/if}
</li>

<style>
  .row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.25rem 0;
    list-style: none;
    color: var(--db-fg);
  }
  .row[draggable='true'] { cursor: grab; }
  .check { flex: none; width: 1.25rem; height: 1.25rem; margin: 0.1rem 0 0; accent-color: var(--db-accent); }
  .check:focus-visible { outline: 2px solid var(--db-focus, #1d4ed8); outline-offset: 2px; }
  .mark, .icon { flex: none; width: 1.25rem; text-align: center; }
  .body { display: flex; flex: 1; flex-wrap: wrap; align-items: baseline; gap: 0 0.5rem; min-width: 0; }
  .title { overflow-wrap: anywhere; }
  .done .title { text-decoration: line-through; color: var(--db-muted); }
  .overdue .due { font-weight: 700; }
  .qty, .meta, .note { color: var(--db-muted); font-size: 0.85em; }
  .meta { display: inline-flex; gap: 0.5rem; }
  .note { flex-basis: 100%; }
  .chip { padding: 0 0.4rem; border: var(--db-border, 1px solid currentColor); border-radius: var(--db-radius, 8px); font-size: 0.75em; color: var(--db-muted); }
  .tools { display: inline-flex; flex: none; gap: 0.25rem; }
</style>
