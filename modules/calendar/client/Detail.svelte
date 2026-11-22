<script lang="ts">
  // Calendar detail: agenda / day / week / month views, a calendar filter, and (edit level, owner) an editor with
  // drag-to-move in the time grid. Recurring events ask "this / this and following / all"; a 409 offers reload or
  // overwrite. On narrow screens the week view shows three days.
  import { onMount, untrack } from 'svelte';
  import type { DetailProps } from '@dash/contract';
  import { Button } from '@dash/ui';
  import type { Settings } from '../manifest.js';
  import type { Snapshot } from '../server/reminders.js';
  import Agenda from './Agenda.svelte';
  import Day from './Day.svelte';
  import Editor from './Editor.svelte';
  import { addDays, byStart, localDay, monthGrid, movedTimes, shiftAny, startOfWeek, wallDiffMin, type OccLike } from './format.js';
  import Month from './Month.svelte';
  import { CalendarStore, conflictOf, inputOf, seriesInput, type EventInput, type OccurrenceDto, type Scope } from './store.svelte.js';
  import Week from './Week.svelte';

  let { data, settings, level, isOwner, api, t, locale, timeZone, params }: DetailProps<Snapshot, Settings> = $props();

  type View = 'agenda' | 'day' | 'week' | 'month';
  // The api, zone and deep-link params of the pane are fixed for its lifetime; read once.
  const store = new CalendarStore(untrack(() => api));
  const canEdit = $derived(level === 'edit' && isOwner);
  const weekStart = $derived(settings.weekStart);
  const today = untrack(() => localDay(Date.now(), timeZone));
  const start = untrack(() => ({ view: params['view'] as View | undefined, date: params['date'], defaultView: settings.defaultView }));

  let view = $state<View>((start.view ?? start.defaultView) || 'agenda');
  let cursor = $state(start.date && /^\d{4}-\d{2}-\d{2}$/.test(start.date) ? start.date : today);
  let narrow = $state(false);
  let hidden = $state<string[]>([]);
  let filterReady = false;

  type Editing = { isNew: true; initial: EventInput & { calendarId: string } } | { isNew: false; occ: OccurrenceDto; initial: EventInput & { calendarId: string } };
  let editing = $state<Editing | null>(null);
  let viewing = $state<OccLike | null>(null);
  let busy = $state(false);
  let error = $state('');
  let ask = $state<{ resolve: (s: Scope | null) => void } | null>(null);
  let conflict = $state<{ retry: (etag: string) => Promise<void>; etag: string } | null>(null);

  const range = $derived.by((): { first: string; last: string } => {
    if (view === 'day') return { first: cursor, last: cursor };
    if (view === 'week') return narrow ? { first: cursor, last: addDays(cursor, 2) } : { first: startOfWeek(cursor, weekStart), last: addDays(startOfWeek(cursor, weekStart), 6) };
    if (view === 'month') {
      const g = monthGrid(cursor.slice(0, 7), weekStart);
      return { first: g[0]!, last: g[41]! };
    }
    return { first: cursor, last: addDays(cursor, Math.max(settings.daysAhead, 7)) };
  });

  $effect(() => {
    const { first, last } = range;
    void store.load(`${addDays(first, -1)}T00:00:00.000Z`, `${addDays(last, 2)}T00:00:00.000Z`);
  });

  const calendars = $derived(store.calendars.length > 0 ? store.calendars : (data?.calendars ?? []).map((c) => ({ ...c, kind: 'local' as const, access: 'view' as const, sourceUrl: null, ownerId: '', shares: null })));
  $effect(() => {
    if (filterReady || store.calendars.length === 0) return;
    filterReady = true;
    const wanted = settings.calendarIds;
    if (wanted.length > 0) hidden = store.calendars.filter((c) => !wanted.includes(c.id)).map((c) => c.id);
  });

  const fallback = $derived<OccLike[]>([...(data?.today ?? []), ...(data?.next ?? [])]);
  const shown = $derived<Array<OccLike & { editable?: boolean }>>(
    (store.loaded ? store.events : fallback).filter((o) => !hidden.includes(o.calendarId)).sort(byStart),
  );
  const agendaItems = $derived(shown.filter((o) => (o.allDay ? o.end > cursor : localDay(Date.parse(o.endUtc), timeZone) >= cursor)));

  onMount(() => {
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 640px)') : null;
    narrow = mq?.matches ?? false;
    const onChange = (e: MediaQueryListEvent): void => void (narrow = e.matches);
    mq?.addEventListener('change', onChange);
    void store.loadCalendars().then(() => {
      if (params['mode'] === 'create' && canEdit) openCreate(cursor, 9 * 60);
    });
    return () => mq?.removeEventListener('change', onChange);
  });

  // A deep link (?dp.event=<uid>) opens that event once it is loaded.
  let linked = false;
  $effect(() => {
    const uid = params['event'];
    if (linked || !uid || !store.loaded) return;
    const o = store.events.find((e) => e.uid === uid);
    if (o) {
      linked = true;
      select(o);
    }
  });

  const writableCalendar = (): string | undefined => store.calendars.find((c) => c.kind === 'local' && c.access !== 'view')?.id;

  function openCreate(date: string, minute: number): void {
    const calendarId = writableCalendar();
    if (!calendarId || !canEdit) return;
    const hh = (m: number): string => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
    const endMin = Math.min(minute + 60, 1439);
    viewing = null;
    editing = {
      isNew: true,
      initial: { calendarId, title: '', start: `${date}T${hh(minute)}`, end: `${date}T${hh(endMin)}`, allDay: false, timeZone, rrule: null },
    };
  }

  function select(o: OccLike): void {
    const full = store.events.find((e) => e.uid === o.uid && e.calendarId === o.calendarId && e.startUtc === o.startUtc);
    if (full && canEdit && full.editable) {
      viewing = null;
      editing = { isNew: false, occ: full, initial: { ...inputOf(full), calendarId: full.calendarId } };
    } else {
      editing = null;
      viewing = full ?? o;
    }
  }

  function askScope(): Promise<Scope | null> {
    return new Promise((resolve) => (ask = { resolve }));
  }
  function answer(s: Scope | null): void {
    ask?.resolve(s);
    ask = null;
  }

  /** Runs a write; a 409 opens the conflict dialog whose "overwrite" repeats it with the server's current etag. */
  async function attempt(write: (etag?: string) => Promise<void>): Promise<boolean> {
    busy = true;
    error = '';
    try {
      await write();
      return true;
    } catch (err) {
      const c = conflictOf(err);
      if (c) conflict = { etag: c.etag, retry: (etag) => write(etag) };
      else error = t('m.calendar.saveFailed', 'Could not save your change.');
      return false;
    } finally {
      busy = false;
    }
  }

  async function writeOcc(o: OccurrenceDto, input: EventInput): Promise<boolean> {
    let scope: Scope = 'all';
    if (o.recurrenceId) {
      const s = await askScope();
      if (!s) return false;
      scope = s;
    }
    const body = scope === 'all' ? seriesInput(o, input, shiftAny, wallDiffMin) : { ...input, rrule: scope === 'this' ? null : (input.rrule ?? null) };
    return attempt((etag) => store.update(o, body, scope, etag ?? o.etag));
  }

  async function save(input: EventInput & { calendarId: string }): Promise<void> {
    const ed = editing;
    if (!ed) return;
    const ok = ed.isNew ? await attempt(() => store.create(input)) : await writeOcc(ed.occ, input);
    if (ok) editing = null;
  }

  async function remove(): Promise<void> {
    const ed = editing;
    if (!ed || ed.isNew) return;
    let scope: Scope = 'all';
    if (ed.occ.recurrenceId) {
      const s = await askScope();
      if (!s) return;
      scope = s;
    }
    if (await attempt((etag) => store.remove(ed.occ, scope, etag ?? ed.occ.etag))) editing = null;
  }

  async function moved(o: OccLike, deltaMin: number, resizeMin: number): Promise<void> {
    const full = store.events.find((e) => e.uid === o.uid && e.calendarId === o.calendarId && e.startUtc === o.startUtc);
    if (!full || !full.editable || !canEdit) return;
    await writeOcc(full, { ...inputOf(full), ...movedTimes(full, deltaMin, resizeMin) });
  }

  async function resolveConflict(overwrite: boolean): Promise<void> {
    const c = conflict;
    conflict = null;
    if (!c) return;
    if (overwrite) {
      if (await attempt(() => c.retry(c.etag))) editing = null;
    } else {
      editing = null;
      await store.reload();
    }
  }

  function step(dir: -1 | 1): void {
    if (view === 'month') {
      const [y, m] = cursor.slice(0, 7).split('-').map(Number) as [number, number];
      const d = new Date(Date.UTC(y, m - 1 + dir, 1));
      cursor = d.toISOString().slice(0, 10);
    } else cursor = addDays(cursor, dir * (view === 'day' ? 1 : view === 'week' ? (narrow ? 3 : 7) : 7));
  }

  const heading = $derived(
    view === 'month'
      ? new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${cursor.slice(0, 7)}-01T00:00:00Z`))
      : new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${range.first}T00:00:00Z`)),
  );
  const VIEWS: Array<[View, string, string]> = [
    ['agenda', 'm.calendar.view.agenda', 'Agenda'],
    ['day', 'm.calendar.view.day', 'Day'],
    ['week', 'm.calendar.view.week', 'Week'],
    ['month', 'm.calendar.view.month', 'Month'],
  ];
  const gridProps = $derived({ events: shown, today, timeZone, locale, t, canEdit, onselect: select, oncreate: openCreate, onmove: moved });
</script>

<section class="cal-detail">
  <header class="bar">
    <div class="views" role="group" aria-label={t('m.calendar.views', 'Views')}>
      {#each VIEWS as [v, key, label] (v)}
        <button type="button" aria-pressed={view === v} onclick={() => (view = v)}>{t(key, label)}</button>
      {/each}
    </div>
    <div class="nav">
      <button type="button" onclick={() => step(-1)} aria-label={t('m.calendar.prev', 'Previous')}>‹</button>
      <button type="button" onclick={() => (cursor = today)}>{t('m.calendar.today', 'Today')}</button>
      <button type="button" onclick={() => step(1)} aria-label={t('m.calendar.next', 'Next')}>›</button>
      <h2 class="title"><span data-value>{heading}</span></h2>
    </div>
    {#if canEdit && store.calendars.some((c) => c.kind === 'local' && c.access !== 'view')}
      <Button data-edit onclick={() => openCreate(cursor, 9 * 60)}>{t('m.calendar.newEvent', 'New event')}</Button>
    {/if}
  </header>

  {#if calendars.length > 0}
    <fieldset class="filter">
      <legend>{t('m.calendar.calendars', 'Calendars')}</legend>
      {#each calendars as c (c.id)}
        <label>
          <input
            type="checkbox"
            checked={!hidden.includes(c.id)}
            onchange={() => (hidden = hidden.includes(c.id) ? hidden.filter((x) => x !== c.id) : [...hidden, c.id])}
          />
          <span class="dot" style:background={c.color} aria-hidden="true"></span><span data-user>{c.name}</span>
        </label>
      {/each}
    </fieldset>
  {/if}

  {#if store.failed}<p class="error" role="alert">{t('m.calendar.loadFailed', 'Could not load the calendar.')}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if ask}
    <div class="dialog" role="dialog" aria-modal="false" aria-label={t('m.calendar.scope.title', 'Change a repeating event')} data-testid="scope">
      <p>{t('m.calendar.scope.question', 'This is a repeating event. What should change?')}</p>
      <Button onclick={() => answer('this')}>{t('m.calendar.scope.this', 'This event')}</Button>
      <Button onclick={() => answer('future')}>{t('m.calendar.scope.future', 'This and following events')}</Button>
      <Button onclick={() => answer('all')}>{t('m.calendar.scope.all', 'All events')}</Button>
      <Button onclick={() => answer(null)}>{t('m.calendar.cancel', 'Cancel')}</Button>
    </div>
  {/if}
  {#if conflict}
    <div class="dialog" role="alertdialog" aria-label={t('m.calendar.conflict.title', 'Changed elsewhere')} data-testid="conflict">
      <p>{t('m.calendar.conflict.text', 'This event was changed elsewhere. Reload it, or overwrite those changes with yours?')}</p>
      <Button onclick={() => resolveConflict(false)}>{t('m.calendar.conflict.reload', 'Reload')}</Button>
      <Button data-edit onclick={() => resolveConflict(true)}>{t('m.calendar.conflict.overwrite', 'Overwrite')}</Button>
    </div>
  {/if}

  {#if editing && canEdit}
    {#key editing}
      <Editor
        initial={editing.initial}
        calendars={store.calendars}
        isNew={editing.isNew}
        {busy}
        {weekStart}
        {t}
        {locale}
        onsave={(input) => void save(input)}
        oncancel={() => (editing = null)}
        {...editing.isNew ? {} : { ondelete: () => void remove() }}
      />
    {/key}
  {:else if viewing}
    <article class="card" data-testid="event-card">
      <h3 data-user>{viewing.displayTitle}</h3>
      {#if 'location' in viewing && typeof viewing.location === 'string' && viewing.location}<p data-user>{viewing.location}</p>{/if}
      {#if 'description' in viewing && typeof viewing.description === 'string' && viewing.description}<p class="desc" data-user>{viewing.description}</p>{/if}
      <Button onclick={() => (viewing = null)}>{t('m.calendar.close', 'Close')}</Button>
    </article>
  {/if}

  <div class="body">
    {#if view === 'month'}
      <Month month={cursor.slice(0, 7)} {weekStart} events={shown} {today} {timeZone} {locale} {t} onday={(d) => ((cursor = d), (view = 'day'))} onselect={select} />
    {:else if view === 'week'}
      <Week {cursor} {weekStart} {narrow} {...gridProps} />
    {:else if view === 'day'}
      <Day {cursor} {...gridProps} />
    {:else if agendaItems.length === 0}
      <p class="muted">{t('m.calendar.empty', 'No upcoming events.')}</p>
    {:else}
      <Agenda items={agendaItems} {today} {t} {locale} {timeZone} onselect={select} />
    {/if}
  </div>
</section>

<style>
  .cal-detail { display: grid; gap: 0.75rem; color: var(--db-fg); }
  .bar { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; justify-content: space-between; }
  .views, .nav { display: flex; gap: 0.25rem; align-items: center; flex-wrap: wrap; }
  .views button, .nav button { font: inherit; padding: 0.25rem 0.6rem; color: inherit; background: var(--db-surface); border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 6px); cursor: pointer; }
  .views button[aria-pressed='true'] { background: var(--db-accent, #1d4ed8); color: var(--db-on-accent, #fff); }
  button:focus-visible { outline: 2px solid var(--db-focus, #1d4ed8); outline-offset: 2px; }
  .title { margin: 0 0 0 0.5rem; font-size: 1rem; }
  .filter { display: flex; flex-wrap: wrap; gap: 0.75rem; border: 0; margin: 0; padding: 0; }
  .filter legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .filter label { display: inline-flex; align-items: center; gap: 0.3rem; }
  .dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; }
  .dialog, .card { display: grid; gap: 0.5rem; padding: 0.75rem; border: var(--db-border, 1px solid #c9ced6); border-radius: var(--db-radius, 8px); background: var(--db-surface); }
  .dialog p, .card p, .card h3 { margin: 0; }
  .desc { white-space: pre-wrap; }
  .error { margin: 0; border-left: 3px solid var(--db-crit); padding-left: 0.5em; }
  .muted { margin: 0; color: var(--db-muted); }
</style>
