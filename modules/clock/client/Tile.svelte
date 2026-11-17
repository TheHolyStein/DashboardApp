<script lang="ts">
  // Clock tile. Needs-setup state: not applicable, the clock needs no configuration, and it keeps
  // showing the time with `data` undefined (the snapshot only adds timers and the next event).
  import { getContext, type Component } from 'svelte';
  import type { ClockFaceProps, TileProps } from '@dash/contract';
  import type { Settings, Snapshot } from '../manifest.js';
  import { formatRemaining, formatTime, useNow, userZone } from './useNow.svelte.js';

  let { data, settings, size, mode, t, openDetail }: TileProps<Snapshot, Settings> = $props();

  /** The slice of the shell's theme seam this tile uses (context `dash:theme`; absent in module tests). */
  type ThemeSeam = { readonly id?: string; clockFace?(id?: string): Promise<Component<ClockFaceProps>> };
  const theme = getContext<ThemeSeam | undefined>('dash:theme');

  const MAX_TIMERS = 2;
  const timeZone = $derived(settings.timeZone || userZone());

  // Seconds resolution only when the face shows seconds or a countdown is running.
  const timersRunning = $derived((data?.timers.length ?? 0) > 0);
  const ticker = useNow({
    get seconds() {
      return settings.showSeconds || timersRunning;
    },
  });
  const now = $derived(ticker.now);

  // The theme's clock face: loading, ready, or none (no theme seam or it failed) -> built-in digital.
  let Face = $state.raw<Component<ClockFaceProps> | null>(null);
  let faceState = $state<'loading' | 'ready' | 'none'>(theme?.clockFace ? 'loading' : 'none');
  $effect(() => {
    void theme?.id; // re-resolve when the theme changes
    const id = settings.face || undefined;
    if (!theme?.clockFace) return;
    let live = true;
    const resolve = async (): Promise<Component<ClockFaceProps> | null> => {
      try {
        return await theme.clockFace!(id);
      } catch {
        // Unknown or broken face id: ask for the theme default.
        if (!id) return null;
        try {
          return await theme.clockFace!(undefined);
        } catch {
          return null;
        }
      }
    };
    void resolve().then((c) => {
      if (!live) return;
      Face = c;
      faceState = c ? 'ready' : 'none';
    });
    return () => {
      live = false;
    };
  });

  const faceProps = $derived<ClockFaceProps>({
    now,
    mode,
    size,
    showSeconds: settings.showSeconds,
    hour12: settings.hour12,
    timeZone,
    ...(settings.label ? { label: settings.label } : {}),
  });

  // `t` wraps formatted values so every visible string goes through it (themes may reformat).
  const fallbackText = $derived(
    t('m.clock.value', '{value}', {
      value: formatTime(now, { timeZone, hour12: settings.hour12, seconds: settings.showSeconds }),
    }),
  );
  const dateText = $derived(
    t('m.clock.date', '{date}', {
      date: new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone }).format(now),
    }),
  );

  /** "in 25 min", "in 2 h", "in 3 days", "now". Minutes round up so the last minute never reads "now". */
  const countdown = $derived.by(() => {
    if (!data?.nextEvent) return '';
    const minutes = Math.ceil((Date.parse(data.nextEvent.start) - now.getTime()) / 60_000);
    if (Number.isNaN(minutes) || minutes <= 0) return t('m.clock.now', 'now');
    if (minutes < 60) return minutes === 1 ? t('m.clock.inMin.one', 'in 1 min') : t('m.clock.inMin.other', 'in {n} min', { n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours === 1 ? t('m.clock.inHour.one', 'in 1 h') : t('m.clock.inHour.other', 'in {n} h', { n: hours });
    const days = Math.floor(hours / 24);
    return days === 1 ? t('m.clock.inDay.one', 'in 1 day') : t('m.clock.inDay.other', 'in {n} days', { n: days });
  });

  const shownTimers = $derived((data?.timers ?? []).slice(0, MAX_TIMERS));
  const hiddenTimers = $derived(Math.max(0, (data?.timers.length ?? 0) - MAX_TIMERS));
  // At the minimum size (2x1) only the face and its label fit.
  const roomy = $derived(size.h >= 2);
</script>

<div class="clock-tile">
  <!-- The shell's tile frame has no open control of its own; this transparent button covers the tile. -->
  <button type="button" class="open" aria-label={t('m.clock.open', 'Open clock details')} onclick={() => openDetail()}></button>
  <div class="face" aria-busy={faceState === 'loading'}>
    {#if faceState === 'ready' && Face}
      <Face {...faceProps} />
    {:else if faceState === 'none'}
      <div class="fallback">
        <time datetime={now.toISOString()}>{fallbackText}</time>
        {#if settings.label}<span class="label">{settings.label}</span>{/if}
      </div>
    {/if}
  </div>

  {#if roomy}
    <div class="extras">
      {#if settings.showDate}<p class="date">{dateText}</p>{/if}
      {#if settings.showNextEvent && data?.nextEvent}
        <p class="event"><span class="title">{data.nextEvent.title}</span> <span class="when">{countdown}</span></p>
      {/if}
      {#if shownTimers.length > 0}
        <ul class="timers">
          {#each shownTimers as timer (timer.id)}
            <li>
              <span class="timer-label">{timer.label || t('m.clock.timer', 'Timer')}</span>
              <span class="remaining">{formatRemaining(Date.parse(timer.endsAt) - now.getTime())}</span>
            </li>
          {/each}
          {#if hiddenTimers > 0}<li class="more">{t('m.clock.moreTimers', '+{n}', { n: hiddenTimers })}</li>{/if}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .clock-tile {
    position: relative;
    container-type: inline-size;
    display: grid;
    gap: var(--db-gap, 8px);
    align-content: center;
    justify-items: center;
    width: 100%;
    height: 100%;
    color: var(--db-fg);
    text-align: center;
  }
  .open {
    position: absolute;
    inset: 0;
    border: 0;
    background: transparent;
    cursor: pointer;
  }
  .open:focus-visible {
    outline: 2px solid var(--db-focus, currentcolor);
    outline-offset: -2px;
  }
  .face {
    width: 100%;
    min-height: 1.5rem;
  }
  .fallback time {
    display: block;
    font-family: var(--db-font-display);
    font-size: clamp(1.25rem, 18cqw, 3rem);
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }
  .label,
  .date,
  .when,
  .more {
    color: var(--db-muted);
  }
  .extras {
    display: grid;
    gap: 0.25rem;
    width: 100%;
    font-size: 0.9rem;
  }
  p,
  ul {
    margin: 0;
    padding: 0;
  }
  .timers {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.25rem 1rem;
    list-style: none;
  }
  .remaining {
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  /* Wide tiles: date, event and timers share one line. */
  @container (min-width: 22rem) {
    .extras {
      grid-auto-flow: column;
      justify-content: space-around;
      font-size: 1rem;
    }
  }
</style>
