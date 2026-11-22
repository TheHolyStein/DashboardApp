<script lang="ts">
  // Event editor. Emits the event input; the detail view decides scope (recurring events) and handles conflicts.
  import { untrack } from 'svelte';
  import type { Translate } from '@dash/contract';
  import { Button } from '@dash/ui';
  import { parseCommands } from '../server/commands/parse.js';
  import { addDays } from './format.js';
  import RepeatPicker from './RepeatPicker.svelte';
  import type { CalendarDto, EventInput } from './store.svelte.js';

  let {
    initial,
    calendars,
    isNew,
    busy = false,
    weekStart = 'mon',
    t,
    locale,
    onsave,
    oncancel,
    ondelete,
  }: {
    initial: EventInput & { calendarId: string };
    calendars: CalendarDto[];
    isNew: boolean;
    busy?: boolean;
    weekStart?: 'mon' | 'sun';
    t: Translate;
    locale: string;
    onsave: (input: EventInput & { calendarId: string }) => void;
    oncancel: () => void;
    ondelete?: () => void;
  } = $props();

  // A snapshot of the starting values: the form owns its state from here on.
  const init = untrack(() => $state.snapshot(initial));
  let title = $state(init.title);
  let calendarId = $state(init.calendarId);
  let allDay = $state(init.allDay);
  let startDate = $state(init.start.slice(0, 10));
  let startTime = $state(init.allDay ? '09:00' : init.start.slice(11, 16));
  // All-day ends are exclusive in storage, inclusive on screen.
  let endDate = $state(init.allDay ? addDays(init.end.slice(0, 10), -1) : init.end.slice(0, 10));
  let endTime = $state(init.allDay ? '10:00' : init.end.slice(11, 16));
  let timeZone = $state(init.allDay || init.timeZone === 'floating' ? '' : init.timeZone);
  let rrule = $state<string | null>(init.rrule ?? null);
  let location = $state(init.location ?? '');
  let description = $state(init.description ?? '');
  let help = $state(false);
  let invalid = $state('');

  const tokens = $derived(parseCommands(`${title}\n${description}`));
  const writable = $derived(calendars.filter((c) => c.kind === 'local' && c.access !== 'view'));

  const COMMANDS: Array<[string, string, string]> = [
    ['@name', 'm.calendar.help.mention', 'Deadline todo for that person'],
    ['#shopping a, b', 'm.calendar.help.shopping', 'Items on the shopping list'],
    ['#chore', 'm.calendar.help.chore', 'Chore for the first person mentioned'],
    ['!remind 30m', 'm.calendar.help.remind', 'Reminder before the start (m, h, d)'],
    ['!prep 2d', 'm.calendar.help.prep', 'Preparation todo before the start (h, d)'],
    ['!countdown', 'm.calendar.help.countdown', 'Countdown to the start'],
    ['!pin', 'm.calendar.help.pin', 'Pin it to the briefing on its day'],
    ['!wled preset', 'm.calendar.help.wled', 'Apply a light preset at the start'],
    ['#private', 'm.calendar.help.private', 'Only you can see it'],
    ['#outdoor', 'm.calendar.help.outdoor', 'Weather hints for this event'],
    ['#birthday 1990', 'm.calendar.help.birthday', 'Birthday with age'],
  ];

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    invalid = '';
    const start = allDay ? startDate : `${startDate}T${startTime}:00`;
    const end = allDay ? addDays(endDate, 1) : `${endDate}T${endTime}:00`;
    if (!title.trim()) return void (invalid = t('m.calendar.err.title', 'Give the event a title.'));
    if (end < start || (!allDay && end === start && startTime !== endTime)) {
      return void (invalid = t('m.calendar.err.order', 'The end must not be before the start.'));
    }
    onsave({
      calendarId,
      title: title.trim(),
      description,
      location,
      start,
      end,
      allDay,
      timeZone: allDay ? 'floating' : timeZone.trim() || 'UTC',
      rrule,
    });
  }
</script>

<form class="editor" onsubmit={submit} data-testid="editor">
  <label class="wide">{t('m.calendar.field.title', 'Title')}
    <input data-edit bind:value={title} maxlength="500" required />
  </label>
  <div class="chips" aria-live="polite" data-testid="chips">
    {#each tokens as tok, i (i)}
      <span class="chip" data-user>{tok.kind === 'mention' ? `@${tok.handle}` : `${tok.kind === 'tag' ? '#' : '!'}${tok.name}${tok.args ? ` ${tok.args}` : ''}`}</span>
    {/each}
    <button type="button" class="help" aria-expanded={help} onclick={() => (help = !help)}>{t('m.calendar.help', 'Commands')}</button>
  </div>
  {#if help}
    <ul class="help-list" data-testid="help">
      {#each COMMANDS as [syntax, key, text] (syntax)}
        <li><code data-user>{syntax}</code> {t(key, text)}</li>
      {/each}
    </ul>
  {/if}

  <label>{t('m.calendar.field.calendar', 'Calendar')}
    <select data-edit bind:value={calendarId}>
      {#each writable as c (c.id)}<option value={c.id} data-user>{c.name}</option>{/each}
    </select>
  </label>
  <label class="check"><input data-edit type="checkbox" bind:checked={allDay} /> {t('m.calendar.allDay', 'All day')}</label>

  <div class="when">
    <label>{t('m.calendar.field.start', 'Start')}
      <input data-edit type="date" bind:value={startDate} required />
      {#if !allDay}<input data-edit type="time" step="900" bind:value={startTime} required aria-label={t('m.calendar.field.startTime', 'Start time')} />{/if}
    </label>
    <label>{t('m.calendar.field.end', 'End')}
      <input data-edit type="date" bind:value={endDate} min={startDate} required />
      {#if !allDay}<input data-edit type="time" step="900" bind:value={endTime} required aria-label={t('m.calendar.field.endTime', 'End time')} />{/if}
    </label>
  </div>
  {#if !allDay}
    <label>{t('m.calendar.field.zone', 'Time zone')}
      <input data-edit bind:value={timeZone} maxlength="64" placeholder="Europe/Berlin" />
    </label>
  {/if}

  <RepeatPicker bind:value={rrule} {allDay} {startDate} {weekStart} {t} {locale} />

  <label class="wide">{t('m.calendar.field.location', 'Location')}<input data-edit bind:value={location} maxlength="500" /></label>
  <label class="wide">{t('m.calendar.field.description', 'Description')}<textarea data-edit bind:value={description} rows="3" maxlength="10000"></textarea></label>

  {#if invalid}<p class="error" role="alert">{invalid}</p>{/if}
  <div class="actions">
    <Button data-edit type="submit" {busy}>{isNew ? t('m.calendar.create', 'Create') : t('m.calendar.save', 'Save')}</Button>
    <Button type="button" onclick={oncancel}>{t('m.calendar.cancel', 'Cancel')}</Button>
    {#if ondelete}<Button data-edit type="button" onclick={ondelete}>{t('m.calendar.delete', 'Delete')}</Button>{/if}
  </div>
</form>

<style>
  .editor { display: grid; gap: 0.6rem; }
  label { display: grid; gap: 0.2rem; }
  .check { display: flex; align-items: center; gap: 0.4rem; }
  .when { display: flex; flex-wrap: wrap; gap: 0.6rem; }
  .when label { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem; }
  input, select, textarea { font: inherit; color: var(--db-fg); background: var(--db-surface); border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 6px); padding: 0.3rem 0.5rem; }
  input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible { outline: 2px solid var(--db-focus, #1d4ed8); outline-offset: 2px; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; min-height: 1.5rem; }
  .chip { font-size: 0.8rem; padding: 0 0.5em; border-radius: 999px; background: var(--db-surface-2, rgba(127, 127, 127, 0.15)); }
  .help { margin-inline-start: auto; font: inherit; font-size: 0.8rem; background: none; border: 0; color: var(--db-accent, inherit); text-decoration: underline; cursor: pointer; }
  .help-list { margin: 0; padding-inline-start: 1.2rem; font-size: 0.85rem; }
  .error { margin: 0; border-left: 3px solid var(--db-crit); padding-left: 0.5em; }
  .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
</style>
