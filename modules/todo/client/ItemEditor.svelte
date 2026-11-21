<script lang="ts">
  // Editor for a new or existing item. It only collects values: the parent calls the API and handles conflicts.
  import { untrack } from 'svelte';
  import type { Translate } from '@dash/contract';
  import { Button, Field } from '@dash/ui';
  import type { RepeatUnit, TodoListId, WireItem } from '../manifest.js';
  import { localDay } from './format.js';
  import IconPicker from './IconPicker.svelte';
  import type { EditorValues } from './model.js';

  type User = { id: string; name: string; handle: string };
  type Props = {
    item: WireItem | null;
    list: TodoListId;
    users: User[];
    t: Translate;
    timeZone: string;
    busy: boolean;
    error: string;
    onsave: (v: EditorValues) => void;
    oncancel: () => void;
    ondelete?: () => void;
  };
  let { item, list, users, t, timeZone, busy, error, onsave, oncancel, ondelete }: Props = $props();

  const initial = untrack(() => item);
  const initialDay = untrack(() => (initial?.due ? localDay(initial.due, timeZone) : ''));
  const initialList = untrack(() => list);
  let title = $state(initial?.title ?? '');
  let icon = $state<string | null>(initial?.icon ?? null);
  let note = $state(initial?.note ?? '');
  let qty = $state(initial?.qty ?? '');
  let day = $state(initialDay);
  let assigneeId = $state(initial?.assigneeId ?? '');
  let visibility = $state<'private' | 'shared'>(initial?.visibility ?? (initialList === 'shopping' || initialList === 'chores' ? 'shared' : 'private'));
  let repeat = $state(initial?.repeatEvery !== null && initial?.repeatEvery !== undefined);
  let every = $state(initial?.repeatEvery ?? 1);
  let unit = $state<RepeatUnit>(initial?.repeatUnit ?? 'week');
  let rotation = $state<string[]>([...(initial?.rotation ?? [])]);

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (title.trim() === '') return;
    const values: EditorValues = {
      title: title.trim(),
      icon,
      note: note.trim() === '' ? null : note,
      qty: list === 'shopping' && qty.trim() !== '' ? qty : null,
      assigneeId: assigneeId === '' ? null : assigneeId,
      visibility,
      repeatEvery: list === 'chores' && repeat ? Math.max(1, Math.floor(every)) : null,
      repeatUnit: list === 'chores' && repeat ? unit : null,
      rotation: list === 'chores' && repeat ? rotation : [],
    };
    if (day !== initialDay) values.due = day === '' ? null : day;
    onsave(values);
  }
  const toggleRotation = (id: string): void => {
    rotation = rotation.includes(id) ? rotation.filter((r) => r !== id) : [...rotation, id];
  };
</script>

<form class="editor" onsubmit={submit}>
  <Field label={t('m.todo.titleLabel', 'Title')}>
    {#snippet children({ describedBy, invalid })}
      <input data-edit bind:value={title} required maxlength="200" aria-describedby={describedBy} aria-invalid={invalid} />
    {/snippet}
  </Field>
  <IconPicker value={icon} {t} onchange={(v) => (icon = v)} />
  <Field label={t('m.todo.note', 'Note')}>
      <textarea data-edit bind:value={note} rows="2" maxlength="2000"></textarea>
  </Field>
  {#if list === 'shopping'}
    <Field label={t('m.todo.qty', 'Quantity')}>
        <input data-edit bind:value={qty} maxlength="40" />
    </Field>
  {/if}
  <Field label={t('m.todo.due', 'Due')} help={list === 'week' || list === 'month' ? t('m.todo.dueHelp', 'Empty = end of the current period') : undefined}>
      <span class="inline">
        <input data-edit type="date" bind:value={day} />
        {#if day !== ''}<Button data-edit onclick={() => (day = '')}>{t('m.todo.clearDue', 'Clear')}</Button>{/if}
      </span>
  </Field>
  <Field label={t('m.todo.assignee', 'Assigned to')}>
      <select data-edit bind:value={assigneeId}>
        <option value="">{t('m.todo.nobody', 'Nobody')}</option>
        {#each users as user (user.id)}
          <option value={user.id}>{user.name}</option>
        {/each}
      </select>
  </Field>
  <label class="check">
    <input data-edit type="checkbox" checked={visibility === 'shared'} onchange={(e) => (visibility = e.currentTarget.checked ? 'shared' : 'private')} />
    <span>{t('m.todo.shared', 'Visible to everyone')}</span>
  </label>

  {#if list === 'chores'}
    <fieldset class="repeat">
      <legend>{t('m.todo.repeat', 'Repeat')}</legend>
      <label class="check">
        <input data-edit type="checkbox" bind:checked={repeat} />
        <span>{t('m.todo.repeatOn', 'Repeating chore')}</span>
      </label>
      {#if repeat}
        <span class="inline">
          <label>{t('m.todo.every', 'Every')} <input data-edit type="number" min="1" max="365" bind:value={every} class="num" /></label>
          <select data-edit bind:value={unit} aria-label={t('m.todo.unit', 'Unit')}>
            <option value="day">{t('m.todo.unit.day', 'days')}</option>
            <option value="week">{t('m.todo.unit.week', 'weeks')}</option>
            <option value="month">{t('m.todo.unit.month', 'months')}</option>
          </select>
        </span>
        <fieldset class="rotation">
          <legend>{t('m.todo.rotation', 'Take turns')}</legend>
          {#each users as user (user.id)}
            <label class="check">
              <input data-edit type="checkbox" checked={rotation.includes(user.id)} onchange={() => toggleRotation(user.id)} />
              <span data-user>{user.name}</span>
            </label>
          {/each}
        </fieldset>
      {/if}
    </fieldset>
  {/if}

  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="actions">
    <Button data-edit type="submit" variant="primary" {busy}>{t('m.todo.save', 'Save')}</Button>
    <Button data-edit onclick={oncancel}>{t('m.todo.cancel', 'Cancel')}</Button>
    {#if ondelete}<Button data-edit variant="danger" onclick={ondelete}>{t('m.todo.delete', 'Delete')}</Button>{/if}
  </div>
</form>

<style>
  .editor { display: grid; gap: 0.25rem; }
  input:not([type='checkbox']), textarea, select { font: inherit; padding: 0.4rem 0.6rem; color: var(--db-fg); background: var(--db-surface); border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px); }
  input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid var(--db-focus, #1d4ed8); outline-offset: 2px; }
  .inline { display: inline-flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .check { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; }
  .num { width: 4.5rem; }
  fieldset { border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px); margin: 0 0 var(--db-gap, 8px); }
  .error { margin: 0; border-left: 3px solid var(--db-crit); padding-left: 0.5em; }
  .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
</style>
