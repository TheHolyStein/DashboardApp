<script lang="ts">
  // Briefing tile. Needs-setup state: not applicable, there is nothing to configure to see a briefing (the time zone
  // setting has a default). Nothing in the tile is interactive: the shell's tile frame opens the detail pane.
  import { onMount, untrack } from 'svelte';
  import type { TileProps } from '@dash/contract';
  import type { Settings, Snapshot } from '../manifest.js';
  import { countdown, formatDay, hintText } from './format.js';

  let { data: pushed, size, t, locale, timeZone }: TileProps<Snapshot, Settings> = $props();

  // A snapshot older than the one on screen (a late or reordered push) is ignored; a new server epoch always wins.
  let data = $state.raw<Snapshot | undefined>(untrack(() => pushed));
  $effect.pre(() => {
    const next = pushed;
    untrack(() => {
      if (next && (!data || next.epoch !== data.epoch || next.rev >= data.rev)) data = next;
    });
  });

  // The countdown keeps moving between snapshots; once a minute is fine for minute resolution.
  let now = $state(new Date());
  onMount(() => {
    const timer = setInterval(() => (now = new Date()), 30_000);
    return () => clearInterval(timer);
  });

  const greetings = {
    morning: 'Good morning',
    day: 'Hello',
    evening: 'Good evening',
    night: 'Good night',
  } as const;

  // At the minimum height (one row) only the greeting and the next event fit.
  const roomy = $derived(size.h >= 2);
  const todoCount = $derived(data?.todos.due.length ?? 0);
  const overdue = $derived(data?.todos.overdue ?? 0);
  const hint = $derived(data?.weatherHint ? hintText(data.weatherHint, t, locale, timeZone) : '');
  const nextStarted = $derived(data?.next ? Date.parse(data.next.start) <= now.getTime() : false);
</script>

<div class="briefing-tile">
  {#if data}
    <header>
      <h3 class="greeting">{t(`m.briefing.greeting.${data.greeting}`, greetings[data.greeting])}</h3>
      <p class="date" data-value>{formatDay(data.date, locale)}</p>
    </header>

    <p class="next">
      {#if data.next && !nextStarted}
        <span class="title" data-user>{data.next.title}</span>
        <span class="when">{countdown(data.next.start, now, t)}</span>
      {:else}
        <span class="when">{t('m.briefing.nothingNext', 'Nothing else on the calendar today')}</span>
      {/if}
    </p>

    {#if roomy}
      <div class="extras">
        {#if data.eventsToday > 0}
          <p class="count">
            {data.eventsToday === 1
              ? t('m.briefing.events.one', '1 event today')
              : t('m.briefing.events.other', '{n} events today', { n: data.eventsToday })}
          </p>
        {/if}
        {#if todoCount > 0 || overdue > 0}
          <p class="count">
            {overdue > 0
              ? t('m.briefing.todos.overdue', '{n} to do, {o} overdue', { n: todoCount, o: overdue })
              : t('m.briefing.todos', '{n} to do', { n: todoCount })}
          </p>
        {/if}
        {#if hint}<p class="hint">{hint}</p>{/if}
        {#each data.pins as pin (pin.title)}
          <p class="pin"><span data-user>{pin.title}</span></p>
        {/each}
      </div>
      {#if data.alerts.length > 0}
        <ul class="alerts">
          {#each data.alerts as alert (alert.level + alert.title)}
            <li class={alert.level}>
              <span class="level">{alert.level === 'critical' ? t('m.briefing.critical', 'Critical') : t('m.briefing.warning', 'Warning')}</span>
              <span data-user>{alert.title}</span>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  {:else}
    <p class="when">{t('m.briefing.waiting', 'Waiting for your day…')}</p>
  {/if}
</div>

<style>
  .briefing-tile {
    container-type: inline-size;
    display: grid;
    gap: var(--db-gap, 8px);
    align-content: start;
    width: 100%;
    height: 100%;
    color: var(--db-fg);
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0 var(--db-gap, 8px);
  }
  p,
  ul,
  h3 {
    margin: 0;
    padding: 0;
  }
  .greeting {
    font-family: var(--db-font-heading);
    font-size: 1.25rem;
  }
  .date,
  .when,
  .count,
  .level {
    color: var(--db-muted);
  }
  .title {
    font-weight: 600;
  }
  .extras {
    display: grid;
    gap: 0.25rem;
  }
  .alerts {
    display: grid;
    gap: 0.25rem;
    list-style: none;
  }
  .alerts li {
    border-inline-start: 4px solid var(--db-warn);
    padding-inline-start: 0.5rem;
  }
  .alerts li.critical {
    border-inline-start-color: var(--db-crit);
  }
  /* Wide tiles: the figures sit side by side. */
  @container (min-width: 28rem) {
    .extras {
      grid-auto-flow: column;
      justify-content: start;
      gap: 0.25rem 1.5rem;
    }
  }
</style>
