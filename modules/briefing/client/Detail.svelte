<script lang="ts">
  // Briefing detail: the full agenda for today and tomorrow, all due todos, the weather hint, pins and alerts.
  // The agenda is not part of the snapshot: the owner's pane loads it through GET /day. On a shared page
  // (`isOwner` false) the route would answer for the viewer, so only the owner's snapshot is shown.
  import { untrack } from 'svelte';
  import type { DetailProps } from '@dash/contract';
  import { Button, Empty } from '@dash/ui';
  import type { AgendaEvent, DayDetail, Settings, Snapshot } from '../manifest.js';
  import { alertKey, alertText, formatClock, formatDay, hintText, listName } from './format.js';

  let { data, isOwner, api, t, locale, timeZone, close }: DetailProps<Snapshot, Settings> = $props();

  // The one source of truth for the agenda: every answer goes through `applyDay`, which keeps only data at
  // least as new as what is held (a new server epoch always wins).
  let day = $state.raw<DayDetail | undefined>();
  let error = $state('');

  function applyDay(incoming: DayDetail): void {
    if (!day || incoming.epoch !== day.epoch || incoming.rev >= day.rev) day = incoming;
  }

  // Loads when the pane opens and again whenever the snapshot moves on (a push means something changed).
  $effect(() => {
    void data?.epoch;
    void data?.rev;
    if (!isOwner) return;
    untrack(() => {
      api.get<DayDetail>('/day').then(
        (answer) => {
          error = '';
          applyDay(answer);
        },
        () => (error = t('m.briefing.loadFailed', 'Could not load your agenda.')),
      );
    });
  });

  const greetings = { morning: 'Good morning', day: 'Hello', evening: 'Good evening', night: 'Good night' } as const;

  // Todos and alerts come from the agenda answer when there is one, else from the snapshot.
  const todos = $derived(day?.todos ?? data?.todos ?? { due: [], overdue: 0 });
  const alerts = $derived(day?.alerts ?? data?.alerts ?? []);
  const hint = $derived(data?.weatherHint ? hintText(data.weatherHint, t, locale, timeZone) : '');
  // Without the agenda (shared page, failed fetch) the snapshot still knows the next event.
  const fallbackToday = $derived<AgendaEvent[]>(
    data?.next ? [{ uid: 'next', title: data.next.title, start: data.next.start, end: data.next.start, allDay: false }] : [],
  );
  const today = $derived(day ? day.today : fallbackToday);
  const tomorrow = $derived(day?.tomorrow ?? []);
</script>

{#snippet agenda(events: AgendaEvent[])}
  <ul class="rows">
    {#each events as event (event.uid + event.start)}
      <li>
        <span class="time" data-value>{event.allDay ? '' : formatClock(event.start, locale, timeZone)}</span>
        {#if event.allDay}<span class="time">{t('m.briefing.allDay', 'All day')}</span>{/if}
        <span class="title" data-user>{event.title}</span>
      </li>
    {/each}
  </ul>
{/snippet}

<div class="briefing-detail">
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if data}
    <header>
      <h3>{t(`m.briefing.greeting.${data.greeting}`, greetings[data.greeting])}</h3>
      <p class="muted" data-value>{formatDay(data.date, locale)}</p>
    </header>
    {#if hint}<p class="hint">{hint}</p>{/if}
  {/if}

  {#if alerts.length > 0}
    <section aria-labelledby="briefing-alerts">
      <h4 id="briefing-alerts">{t('m.briefing.alerts', 'Alerts')}</h4>
      <ul class="rows">
        {#each alerts as alert (alertKey(alert))}
          <li class={alert.level}>
            <span class="level">{alert.level === 'critical' ? t('m.briefing.critical', 'Critical') : t('m.briefing.warning', 'Warning')}</span>
            <span data-user>{alertText(alert, t)}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section aria-labelledby="briefing-today">
    <h4 id="briefing-today">{t('m.briefing.today', 'Today')}</h4>
    {#if today.length > 0}
      {@render agenda(today)}
    {:else}
      <Empty text={t('m.briefing.noEvents', 'No events today.')} />
    {/if}
  </section>

  {#if tomorrow.length > 0}
    <section aria-labelledby="briefing-tomorrow">
      <h4 id="briefing-tomorrow">{t('m.briefing.tomorrow', 'Tomorrow')}</h4>
      {@render agenda(tomorrow)}
    </section>
  {/if}

  <section aria-labelledby="briefing-todos">
    <h4 id="briefing-todos">{t('m.briefing.todosHeading', 'To do')}</h4>
    {#if todos.overdue > 0}
      <p class="muted">{t('m.briefing.overdue', '{n} overdue', { n: todos.overdue })}</p>
    {/if}
    {#if todos.due.length > 0}
      <ul class="rows">
        {#each todos.due as todo, i (i)}
          <li>
            <span class="title" data-user>{todo.title}</span>
            <span class="muted">{listName(todo.list, t)}</span>
          </li>
        {/each}
      </ul>
    {:else}
      <Empty text={t('m.briefing.noTodos', 'Nothing due today.')} />
    {/if}
  </section>

  {#if data && data.pins.length > 0}
    <section aria-labelledby="briefing-pins">
      <h4 id="briefing-pins">{t('m.briefing.pins', 'Pinned for today')}</h4>
      <ul class="rows">
        {#each data.pins as pin (pin.key)}
          <li><span class="title" data-user>{pin.title}</span></li>
        {/each}
      </ul>
    </section>
  {/if}

  <Button onclick={() => close()}>{t('m.briefing.close', 'Close')}</Button>
</div>

<style>
  .briefing-detail {
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
  .muted,
  .time,
  .level {
    color: var(--db-muted);
  }
  .rows {
    display: grid;
    gap: 0.25rem;
    list-style: none;
  }
  .rows li {
    display: flex;
    flex-wrap: wrap;
    gap: 0 0.75rem;
  }
  .time {
    min-width: 4.5rem;
    font-variant-numeric: tabular-nums;
  }
  li.warn {
    border-inline-start: 4px solid var(--db-warn);
    padding-inline-start: 0.5rem;
  }
  li.critical {
    border-inline-start: 4px solid var(--db-crit);
    padding-inline-start: 0.5rem;
  }
  .error {
    color: var(--db-fg);
    border-inline-start: 4px solid var(--db-crit);
    padding-inline-start: 0.5rem;
  }
</style>
