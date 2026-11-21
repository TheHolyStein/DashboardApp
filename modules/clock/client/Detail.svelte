<script lang="ts">
  // Clock detail: world clocks, timers, stopwatch. Controls that change stored data carry `data-edit` and
  // are not rendered at level `view`; the stopwatch is local to this pane, so everyone may use it.
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { DashError, type DetailProps } from '@dash/contract';
  import { Button, Empty, Field, serial } from '@dash/ui';
  import type { Settings, Snapshot } from '../manifest.js';
  import { formatRemaining, formatStopwatch, formatTime } from './format.js';
  import { createStopwatch } from './stopwatch.svelte.js';
  import { useNow } from './useNow.svelte.js';

  type Timer = Snapshot['timers'][number];
  type Props = DetailProps<Snapshot, Settings> & {
    /** Millisecond clock for the stopwatch; defaults to `performance.now()`. Tests inject their own. */
    clock?: () => number;
  };

  let { data, settings, level, api, t, clock, locale }: Props = $props();

  const MAX_ZONES = 12;
  const MAX_TIMER_SEC = 86_400;

  // Zones are not part of the snapshot: they load through GET /zones.
  let zones = $state<string[]>([]);
  let zonesLoaded = $state(false);
  let timers = $state<Timer[]>(untrack(() => data?.timers ?? []));
  let error = $state('');
  let zonesHeading = $state<HTMLElement>();
  let timersHeading = $state<HTMLElement>();

  /** The server's message for a rejected input (422), else the generic text. */
  const failure = (err: unknown): string =>
    err instanceof DashError && err.code === 'invalid' && err.message
      ? err.message
      : t('m.clock.saveFailed', 'Could not save your change.');

  /** After a row disappears the focused button is gone: park focus on the section heading. */
  async function focusAfterRemoval(heading: HTMLElement | undefined): Promise<void> {
    await tick();
    heading?.focus();
  }

  // A pushed snapshot replaces the list, then GET /timers settles it: a snapshot built before our own change can
  // arrive after it, and the server's list is the one to trust. The first run is covered by the fetch on open.
  let firstSnapshot = true;
  $effect(() => {
    if (!data?.timers) return;
    timers = data.timers;
    if (firstSnapshot) firstSnapshot = false;
    else void untrack(() => api.get<Timer[]>('/timers')).then((list) => (timers = list), () => undefined);
  });

  onMount(() => {
    api.get<string[]>('/zones').then(
      (list) => {
        zones = list;
        zonesLoaded = true;
      },
      () => {
        zonesLoaded = true;
        error = t('m.clock.loadFailed', 'Could not load the saved data.');
      },
    );
    api.get<Timer[]>('/timers').then(
      (list) => (timers = list),
      () => (error = t('m.clock.loadFailed', 'Could not load the saved data.')),
    );
  });

  // Second resolution only while a timer counts down.
  const ticker = useNow({
    get seconds() {
      return timers.length > 0;
    },
  });
  const now = $derived(ticker.now);

  // World clocks -----------------------------------------------------------------------------------
  const allZones = [...Intl.supportedValuesOf('timeZone'), 'UTC'];
  const addable = $derived(allZones.filter((z) => !zones.includes(z)));
  let chosen = $state('');
  let adding = $state(false);
  let removing = $state<Record<string, true>>({});

  // Edits run one after another, each applied to the list the previous one produced, so none is lost.
  const saveZones = serial(async (edit: (current: string[]) => string[]): Promise<boolean> => {
    const next = edit(zones);
    if (next.length === zones.length && next.every((z, i) => z === zones[i])) return true;
    try {
      zones = await api.put<string[]>('/zones', { zones: next });
      return true;
    } catch (err) {
      error = failure(err);
      return false;
    }
  });
  async function addZone(): Promise<void> {
    if (!chosen || adding) return;
    const zone = chosen;
    chosen = '';
    adding = true;
    error = '';
    try {
      await saveZones((current) => (current.includes(zone) || current.length >= MAX_ZONES ? current : [...current, zone]));
    } finally {
      adding = false;
    }
  }
  async function removeZone(zone: string): Promise<void> {
    if (removing[zone]) return;
    removing[zone] = true;
    error = '';
    try {
      if (await saveZones((current) => current.filter((z) => z !== zone))) await focusAfterRemoval(zonesHeading);
    } finally {
      delete removing[zone];
    }
  }

  // Timers -----------------------------------------------------------------------------------------
  let label = $state('');
  let minutes = $state(5);
  let seconds = $state(0);
  let formError = $state('');
  let creating = $state(false);
  let cancelling = $state<Record<string, true>>({});

  async function createTimer(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (creating) return;
    const durationSec = Math.floor(minutes) * 60 + Math.floor(seconds);
    if (!(durationSec >= 1 && durationSec <= MAX_TIMER_SEC)) {
      formError = t('m.clock.durationInvalid', 'Enter a duration from 1 second to 24 hours.');
      return;
    }
    formError = '';
    error = '';
    creating = true;
    try {
      const created = await api.post<Timer>('/timers', { label: label.trim(), durationSec });
      // The pushed snapshot may already have delivered it.
      timers = [...timers.filter((x) => x.id !== created.id), created].sort((a, b) => a.endsAt.localeCompare(b.endsAt));
      label = '';
    } catch (err) {
      error = failure(err);
    } finally {
      creating = false;
    }
  }
  async function cancelTimer(id: string): Promise<void> {
    if (cancelling[id]) return;
    cancelling[id] = true;
    error = '';
    try {
      await api.delete(`/timers/${id}`);
      timers = timers.filter((x) => x.id !== id);
      await focusAfterRemoval(timersHeading);
    } catch (err) {
      error = failure(err);
    } finally {
      delete cancelling[id];
    }
  }

  // Stopwatch --------------------------------------------------------------------------------------
  const watch = createStopwatch(() => (clock ?? (() => performance.now()))());
  onDestroy(() => watch.dispose());
  const lapTimes = $derived(watch.laps.map((mark, i) => mark - (watch.laps[i - 1] ?? 0)));
</script>

<div class="clock-detail">
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  <section aria-labelledby="clock-zones">
    <h3 id="clock-zones" tabindex="-1" bind:this={zonesHeading}>{t('m.clock.worldClocks', 'World clocks')}</h3>
    {#if !zonesLoaded}
      <p class="loading" aria-busy="true">{t('m.clock.loading', 'Loading…')}</p>
    {:else if zones.length === 0}
      <Empty text={t('m.clock.noZones', 'No world clocks yet.')} />
    {:else}
      <ul class="rows zones">
        {#each zones as zone (zone)}
          <li>
            <span class="name" data-value>{zone}</span>
            <time class="value" data-value>{formatTime(now, { locale, timeZone: zone, hour12: settings.hour12, seconds: false })}</time>
            {#if level === 'edit'}
              <Button
                data-edit
                variant="danger"
                aria-label={t('m.clock.removeZone', 'Remove {zone}', { zone })}
                busy={removing[zone] === true}
                onclick={() => removeZone(zone)}
              >{t('m.clock.remove', 'Remove')}</Button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if level === 'edit'}
      <div class="add" data-edit>
        <Field label={t('m.clock.addZone', 'Add a time zone')}>
          {#snippet children({ describedBy })}
            <!-- A thousand zone names are data, not UI text: `data-value` on each option. -->
            <select data-edit bind:value={chosen} aria-describedby={describedBy} disabled={zones.length >= MAX_ZONES}>
              <option value="">{t('m.clock.chooseZone', 'Choose a zone')}</option>
              {#each addable as zone (zone)}<option value={zone} data-value>{zone}</option>{/each}
            </select>
          {/snippet}
        </Field>
        <Button data-edit variant="primary" disabled={!chosen || zones.length >= MAX_ZONES} busy={adding} onclick={addZone}>
          {t('m.clock.add', 'Add')}
        </Button>
      </div>
    {/if}
  </section>

  <section aria-labelledby="clock-timers">
    <h3 id="clock-timers" tabindex="-1" bind:this={timersHeading}>{t('m.clock.timers', 'Timers')}</h3>
    {#if timers.length === 0}
      <Empty text={t('m.clock.noTimers', 'No running timers.')} />
    {:else}
      <ul class="rows">
        {#each timers as timer (timer.id)}
          <li>
            <span class="name">{#if timer.label}<span data-user>{timer.label}</span>{:else}{t('m.clock.timer', 'Timer')}{/if}</span>
            <span class="value" data-value>{formatRemaining(Date.parse(timer.endsAt) - now.getTime())}</span>
            {#if level === 'edit'}
              <Button
                data-edit
                variant="danger"
                aria-label={t('m.clock.cancelTimer', 'Cancel {label}', { label: timer.label || t('m.clock.timer', 'Timer') })}
                busy={cancelling[timer.id] === true}
                onclick={() => cancelTimer(timer.id)}
              >{t('m.clock.cancel', 'Cancel')}</Button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if level === 'edit'}
      <form class="new-timer" data-edit onsubmit={createTimer}>
        <Field label={t('m.clock.timerLabel', 'Label')}>
          {#snippet children({ describedBy })}
            <input data-edit name="label" type="text" maxlength="40" bind:value={label} aria-describedby={describedBy} />
          {/snippet}
        </Field>
        <Field label={t('m.clock.minutes', 'Minutes')}>
          {#snippet children({ describedBy })}
            <input data-edit name="minutes" type="number" min="0" max="1440" step="1" bind:value={minutes} aria-describedby={describedBy} />
          {/snippet}
        </Field>
        <Field label={t('m.clock.seconds', 'Seconds')} error={formError}>
          {#snippet children({ describedBy, invalid })}
            <input data-edit name="seconds" type="number" min="0" max="59" step="1" bind:value={seconds} aria-describedby={describedBy} aria-invalid={invalid} />
          {/snippet}
        </Field>
        <Button data-edit variant="primary" type="submit" busy={creating}>{t('m.clock.start', 'Start timer')}</Button>
      </form>
    {/if}
  </section>

  <section aria-labelledby="clock-stopwatch">
    <h3 id="clock-stopwatch">{t('m.clock.stopwatch', 'Stopwatch')}</h3>
    <p class="stopwatch" aria-live="off" data-value>{formatStopwatch(watch.elapsedMs)}</p>
    <div class="buttons">
      {#if watch.running}
        <Button onclick={() => watch.stop()}>{t('m.clock.stop', 'Stop')}</Button>
        <Button onclick={() => watch.lap()}>{t('m.clock.lap', 'Lap')}</Button>
      {:else}
        <Button variant="primary" onclick={() => watch.start()}>{t('m.clock.startWatch', 'Start')}</Button>
      {/if}
      <Button onclick={() => watch.reset()} disabled={watch.running || watch.elapsedMs === 0}>{t('m.clock.reset', 'Reset')}</Button>
    </div>
    {#if lapTimes.length > 0}
      <ol class="rows laps">
        {#each lapTimes as lap, i (i)}
          <li><span class="value" data-value>{formatStopwatch(lap)}</span></li>
        {/each}
      </ol>
    {/if}
  </section>
</div>

<style>
  .clock-detail {
    display: grid;
    gap: calc(var(--db-gap, 8px) * 3);
    color: var(--db-fg);
  }
  h3 {
    margin: 0 0 var(--db-gap, 8px);
  }
  h3:focus-visible {
    outline: 2px solid var(--db-focus, currentcolor);
    outline-offset: 2px;
  }
  .rows {
    display: grid;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .rows li {
    display: flex;
    align-items: center;
    gap: var(--db-gap, 8px);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .value,
  .stopwatch {
    font-variant-numeric: tabular-nums;
  }
  .stopwatch {
    margin: 0 0 var(--db-gap, 8px);
    font-family: var(--db-font-display);
    font-size: 2rem;
  }
  .add,
  .new-timer,
  .buttons {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: var(--db-gap, 8px);
    margin-top: var(--db-gap, 8px);
  }
  input[type='number'] {
    width: 6rem;
  }
  .loading {
    margin: 0;
    color: var(--db-muted);
  }
  .error {
    margin: 0;
    padding-left: 0.5em;
    border-left: 3px solid var(--db-crit);
  }
</style>
