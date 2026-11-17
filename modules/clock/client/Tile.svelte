<script lang="ts">
  // Clock tile. Needs-setup state: not applicable, the clock needs no configuration, and it keeps
  // showing the time with `data` undefined (the snapshot only adds timers and the next event).
  // Nothing in the tile is interactive: the shell's tile frame opens the detail pane.
  import { getContext, type Component } from 'svelte';
  import { THEME_CONTEXT_KEY, type ClockFaceProps, type ThemeSeam, type TileProps } from '@dash/contract';
  import type { Settings, Snapshot } from '../manifest.js';
  import { formatDate, formatRemaining, formatTime, userZone } from './format.js';
  import { useNow } from './useNow.svelte.js';

  let { data, settings, size, mode, t }: TileProps<Snapshot, Settings> = $props();

  /** The shell's theme seam (absent in module tests and when no theme is active). */
  const theme = getContext<ThemeSeam | undefined>(THEME_CONTEXT_KEY);

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
    void theme?.id; // re-resolve when the theme changes (the previous face stays until the new one is in)
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

  // Formatted values are data (`<span data-value>` / `<time data-value>` in the markup), not translatable text.
  const timeText = $derived(formatTime(now, { timeZone, hour12: settings.hour12, seconds: settings.showSeconds }));
  const dateText = $derived(formatDate(now, timeZone));

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
  <!-- The time is exposed exactly once: by the theme's face (role="img" + aria-label, a theme rule) or by the
       built-in readout below. While the face loads the readout stays in place, invisible but readable, so
       the space is reserved and there is no layout jump. -->
  <div class="face" aria-busy={faceState === 'loading'}>
    {#if faceState === 'ready' && Face}
      <Face {...faceProps} />
    {:else}
      <div class="fallback" class:pending={faceState === 'loading'}>
        <time datetime={now.toISOString()} data-value>{timeText}</time>
        {#if settings.label}<span class="label">{settings.label}</span>{/if}
      </div>
    {/if}
  </div>

  {#if roomy}
    <div class="extras">
      {#if settings.showDate}<p class="date" data-value>{dateText}</p>{/if}
      {#if settings.showNextEvent && data?.nextEvent}
        <p class="event"><span class="title">{data.nextEvent.title}</span> <span class="when">{countdown}</span></p>
      {/if}
      {#if shownTimers.length > 0}
        <ul class="timers">
          {#each shownTimers as timer (timer.id)}
            <li>
              <span class="timer-label">
                {#if timer.label}{timer.label}{:else}{t('m.clock.timer', 'Timer')}{/if}
              </span>
              <span class="remaining" data-value>{formatRemaining(Date.parse(timer.endsAt) - now.getTime())}</span>
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
  .face {
    width: 100%;
    min-height: 1.5rem;
  }
  .fallback.pending {
    opacity: 0;
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
