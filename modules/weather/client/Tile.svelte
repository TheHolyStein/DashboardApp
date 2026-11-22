<script lang="ts">
  // Weather tile. At the minimum size (2x1) only the temperature and the icon show; from two rows up come the
  // place, the day's range, the rain outlook, the worst pollen and the air quality band.
  // Nothing in the tile is interactive: the shell's tile frame opens the detail pane.
  import type { TileProps } from '@dash/contract';
  import type { Settings, Snapshot } from '../manifest.js';
  import ConditionIcon from './ConditionIcon.svelte';
  import { bandLabel, conditionLabel, formatClock, formatPrecip, formatTemp, levelLabel, pollenLabel } from './format.js';

  let { data, settings, size, level, isOwner, t, locale, timeZone, stale }: TileProps<Snapshot, Settings> = $props();

  const f = $derived(data && !data.needsSetup ? data : undefined);
  const needsSetup = $derived(data?.needsSetup === true);
  const roomy = $derived(size.h >= 2);
  const showPollen = $derived(settings?.show?.pollen !== false);
  const showAir = $derived(settings?.show?.air !== false);
  const showUv = $derived(settings?.show?.uv !== false);
  const worst = $derived(f && showPollen ? f.pollen.reduce<(typeof f.pollen)[number] | undefined>((a, p) => (!a || p.level > a.level ? p : a), undefined) : undefined);
</script>

<div class="wx" class:stale>
  {#if needsSetup}
    <p class="hint">
      {level === 'edit' && isOwner ? t('m.weather.setup', 'Open settings to set up') : t('m.weather.notSetUp', 'Not set up yet')}
    </p>
  {:else if f}
    <div class="main">
      <span class="glyph"><ConditionIcon condition={f.now.condition} label={conditionLabel(t, f.now.condition)} /></span>
      <span class="temp" data-value>{formatTemp(f.now.tempC, f.units, locale)}</span>
    </div>
    {#if roomy}
      <p class="place" data-user>{f.place}</p>
      <p class="range">
        {t('m.weather.high', 'High')} <span data-value>{formatTemp(f.today.maxC, f.units, locale)}</span>
        / {t('m.weather.low', 'Low')} <span data-value>{formatTemp(f.today.minC, f.units, locale)}</span>
        {#if showUv && f.today.uvMax !== null}
          / {t('m.weather.uv', 'UV')} <span data-value>{Math.round(f.today.uvMax)}</span>
        {/if}
      </p>
      <p class="rain">
        {#if f.nextPrecip}
          {t('m.weather.rainFrom', 'Rain from')} <span data-value>{formatClock(f.nextPrecip.at, locale, timeZone)}</span>
          (<span data-value>{formatPrecip(f.nextPrecip.mm, f.units, locale)}</span>)
        {:else}
          {t('m.weather.dry', 'No rain in the next 24 h')}
        {/if}
      </p>
      <p class="chips">
        {#if worst}
          <span class="chip pollen">
            {t('m.weather.pollen', 'Pollen')}: {pollenLabel(t, worst.type)}, {levelLabel(t, worst.level)}
          </span>
        {/if}
        {#if showAir && f.air}
          <span class="chip aqi">{t('m.weather.aqi', 'Air')}: {bandLabel(t, f.air.band)}</span>
        {/if}
      </p>
    {/if}
  {:else}
    <p class="hint">{t('m.weather.loading', 'Loading')}</p>
  {/if}
</div>

<style>
  .wx {
    container-type: inline-size;
    display: grid;
    gap: 0.25rem;
    align-content: center;
    width: 100%;
    height: 100%;
    color: var(--db-fg);
  }
  p {
    margin: 0;
  }
  .main {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .glyph {
    font-size: clamp(1.75rem, 14cqw, 3rem);
    line-height: 1;
    color: var(--db-accent);
  }
  .temp {
    font-family: var(--db-font-display);
    font-size: clamp(1.5rem, 14cqw, 2.75rem);
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }
  .place,
  .range,
  .rain {
    color: var(--db-muted);
    font-size: 0.9rem;
  }
  .place {
    color: var(--db-fg);
    font-weight: 600;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.5rem;
    font-size: 0.8rem;
  }
  .chip {
    padding: 0.05rem 0.5rem;
    border: 1px solid var(--db-border-color, currentColor);
    border-radius: var(--db-radius, 999px);
    background: var(--db-surface-2, transparent);
    color: var(--db-fg);
  }
  .hint {
    color: var(--db-muted);
  }
</style>
