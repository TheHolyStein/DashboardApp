<script lang="ts">
  // Weather detail: current conditions from the snapshot, everything else (48 h, 7 days, pollen per day, air
  // components) from GET /detail. Nothing here changes stored data, so there are no edit controls.
  import type { DetailProps } from '@dash/contract';
  import { Chart } from '@dash/ui';
  import type { DetailData, Settings, Snapshot } from '../manifest.js';
  import ConditionIcon from './ConditionIcon.svelte';
  import PollenBar from './PollenBar.svelte';
  import {
    bandLabel, conditionLabel, formatClock, formatNumber, formatPercent, formatPrecip, formatTemp, formatWeekday, formatWind,
    levelLabel, pollenLabel, precip, temp,
  } from './format.js';

  let { data, settings, api, t, locale, timeZone, updatedAt }: DetailProps<Snapshot, Settings> = $props();

  const f = $derived(data && !data.needsSetup ? data : undefined);
  const showPollen = $derived(settings?.show?.pollen !== false);
  const showAir = $derived(settings?.show?.air !== false);
  const showUv = $derived(settings?.show?.uv !== false);

  let detail = $state.raw<DetailData | undefined>();
  let failed = $state(false);

  // Reload when the instance changes or a fresh snapshot arrives (the server cache keeps this cheap).
  $effect(() => {
    const id = f?.instanceId;
    void updatedAt;
    if (!id) return;
    let live = true;
    api.get<DetailData>('/detail', { instanceId: id }).then(
      (d) => {
        if (!live) return;
        detail = d;
        failed = false;
      },
      () => {
        if (live) failed = true; // a rejected promise is not caught by a boundary: show it ourselves
      },
    );
    return () => {
      live = false;
    };
  });

  const units = $derived(f?.units ?? 'metric');
  const round = (v: number): number => Math.round(v * 10) / 10;
  const tempSeries = $derived([
    { label: t('m.weather.temperature', 'Temperature'), points: (detail?.hourly ?? []).map((h): [number, number] => [h.t, round(temp(h.tempC, units))]) },
  ]);
  const rainSeries = $derived([
    {
      label: t('m.weather.precipitation', 'Precipitation'),
      points: (detail?.hourly ?? []).map((h): [number, number] => [h.t, Math.round(precip(h.precipMm, units) * 100) / 100]),
    },
  ]);
  const tempUnit = $derived(units === 'imperial' ? '°F' : '°C');
  const rainUnit = $derived(units === 'imperial' ? ' in' : ' mm');
  const comps: Array<[keyof NonNullable<DetailData['air']>['components'], string]> = [
    ['pm10', 'PM10'], ['pm25', 'PM2.5'], ['no2', 'NO₂'], ['o3', 'O₃'], ['so2', 'SO₂'],
  ];
</script>

<section class="wx">
  {#if data?.needsSetup}
    <p>{t('m.weather.notSetUp', 'Not set up yet')}</p>
  {:else if !f}
    <p>{t('m.weather.loading', 'Loading')}</p>
  {:else}
    <header class="now">
      <span class="glyph"><ConditionIcon condition={f.now.condition} label={conditionLabel(t, f.now.condition)} /></span>
      <div>
        <h3 class="place" data-user>{f.place}</h3>
        <p class="big"><span data-value>{formatTemp(f.now.tempC, units, locale)}</span> {conditionLabel(t, f.now.condition)}</p>
        <p class="muted">
          {t('m.weather.feels', 'Feels like')} <span data-value>{formatTemp(f.now.feelsC, units, locale)}</span>
          / {t('m.weather.wind', 'Wind')} <span data-value>{formatWind(f.now.windKph, units, locale)}</span>
          / {t('m.weather.humidity', 'Humidity')} <span data-value>{formatPercent(f.now.humidity, locale)}</span>
        </p>
      </div>
    </header>

    {#if failed}<p role="alert">{t('m.weather.loadFailed', 'Could not load the forecast details.')}</p>{/if}

    {#if detail}
      <section aria-labelledby="wx-48h">
        <h4 id="wx-48h">{t('m.weather.next48', 'Next 48 hours')}</h4>
        <Chart kind="line" series={tempSeries} unit={tempUnit} height={150} {locale} {timeZone} ariaLabel={t('m.weather.chartTemp', 'Temperature, next 48 hours')} />
        <Chart kind="bar" series={rainSeries} unit={rainUnit} height={90} {locale} {timeZone} ariaLabel={t('m.weather.chartRain', 'Precipitation, next 48 hours')} />
      </section>

      <section aria-labelledby="wx-days">
        <h4 id="wx-days">{t('m.weather.week', 'Next 7 days')}</h4>
        <ul class="days">
          {#each detail.daily as d (d.date)}
            <li>
              <span class="day" data-value>{formatWeekday(d.date, locale)}</span>
              <span class="glyph small"><ConditionIcon condition={d.condition} label={conditionLabel(t, d.condition)} /></span>
              <span data-value>{formatTemp(d.maxC, units, locale)}</span>
              <span class="muted" data-value>{formatTemp(d.minC, units, locale)}</span>
              {#if d.precipMm > 0}<span class="muted" data-value>{formatPrecip(d.precipMm, units, locale)}</span>{/if}
            </li>
          {/each}
        </ul>
      </section>

      {#if showPollen}
        <section aria-labelledby="wx-pollen">
          <h4 id="wx-pollen">{t('m.weather.pollen', 'Pollen')}</h4>
          {#if detail.pollen.types.length > 0}
            <table class="pollen">
              <thead>
                <tr>
                  <th scope="col"><span class="sr">{t('m.weather.type', 'Type')}</span></th>
                  {#each detail.pollen.dates as date (date)}<th scope="col" data-value>{formatWeekday(date, locale)}</th>{/each}
                </tr>
              </thead>
              <tbody>
                {#each detail.pollen.types as row (row.type)}
                  <tr>
                    <th scope="row">{pollenLabel(t, row.type)}</th>
                    {#each row.levels as lvl, i (i)}
                      <td>
                        <PollenBar level={lvl} label={`${pollenLabel(t, row.type)}: ${lvl === null ? t('m.weather.noData', 'No data') : levelLabel(t, lvl)}`} />
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          {:else}
            <p class="muted">{t('m.weather.noPollen', 'No pollen data for this place.')}</p>
          {/if}
        </section>
      {/if}

      {#if showAir && detail.air}
        <section aria-labelledby="wx-air">
          <h4 id="wx-air">{t('m.weather.airQuality', 'Air quality')}</h4>
          <p class="big"><span data-value>{detail.air.aqi}</span> {bandLabel(t, detail.air.band)}</p>
          <dl class="grid">
            {#each comps as [key, name] (key)}
              {@const v = detail.air.components[key]}
              {#if v !== null}
                <div><dt data-value>{name}</dt><dd data-value>{formatNumber(v, locale)} µg/m³</dd></div>
              {/if}
            {/each}
          </dl>
        </section>
      {/if}
    {/if}

    <section aria-labelledby="wx-sun">
      <h4 id="wx-sun">{t('m.weather.sun', 'Sun')}</h4>
      <dl class="grid">
        <div><dt>{t('m.weather.sunrise', 'Sunrise')}</dt><dd data-value>{formatClock(f.today.sunrise, locale, timeZone)}</dd></div>
        <div><dt>{t('m.weather.sunset', 'Sunset')}</dt><dd data-value>{formatClock(f.today.sunset, locale, timeZone)}</dd></div>
        {#if showUv && f.today.uvMax !== null}
          <div><dt>{t('m.weather.uvMax', 'UV index, highest')}</dt><dd data-value>{formatNumber(f.today.uvMax, locale)}</dd></div>
        {/if}
      </dl>
    </section>
  {/if}
</section>

<style>
  .wx {
    display: grid;
    gap: 1rem;
    color: var(--db-fg);
  }
  h3,
  h4,
  p {
    margin: 0;
  }
  h4 {
    margin-bottom: 0.4rem;
    font-family: var(--db-font-heading);
    text-transform: var(--db-heading-case, none);
    letter-spacing: var(--db-heading-track, normal);
  }
  .now {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .glyph {
    font-size: 3rem;
    line-height: 1;
    color: var(--db-accent);
  }
  .glyph.small {
    font-size: 1.4rem;
  }
  .big {
    font-size: 1.4rem;
  }
  .muted {
    color: var(--db-muted);
  }
  .days {
    display: grid;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .days li {
    display: grid;
    grid-template-columns: 6rem 2rem 1fr 1fr 1fr;
    align-items: center;
    gap: 0.5rem;
    font-variant-numeric: tabular-nums;
  }
  .pollen {
    border-collapse: collapse;
  }
  .pollen th,
  .pollen td {
    padding: 0.2rem 0.5rem;
    text-align: left;
    font-weight: normal;
  }
  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1.5rem;
    margin: 0;
  }
  .grid dt {
    color: var(--db-muted);
    font-size: 0.85rem;
  }
  .grid dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
