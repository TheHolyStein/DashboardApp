<script lang="ts">
  import { getContext, untrack } from 'svelte';
  import type { ChartPalette, Mode } from '@dash/contract';
  import Empty from './Empty.svelte';
  import { useT } from './context.js';
  import {
    DEFAULT_PALETTE, THEME_KEY, applyPalette, buildOptions, defaultLoadPlot, hasAnyData, mergeSeries,
    prefersReducedEffects, renderTooltip, summaryLabel, tooltipModel,
    type ChartKind, type ChartSeries, type LoadPlot, type PlotLike, type PlotModule,
  } from './chart.js';

  interface Props {
    kind: ChartKind;
    series: ChartSeries[];
    unit?: string;
    height?: number;
    maxPoints?: number;
    ariaLabel?: string;
    locale?: string;
    timeZone?: string;
    loadPlot?: LoadPlot;
    resizeObserver?: typeof ResizeObserver;
  }
  let { kind, series, unit, height, maxPoints = 300, ariaLabel, locale, timeZone, loadPlot, resizeObserver }: Props = $props();

  const t = useT();
  const theme = getContext<{ chart?: () => ChartPalette; readonly mode?: Mode } | undefined>(THEME_KEY);

  // Primitive deriveds dedupe, so unrelated prop updates (e.g. new `series`) never re-create the plot.
  const kindD = $derived(kind);
  const localeD = $derived(locale);
  const zoneD = $derived(timeZone);
  const unitD = $derived(unit);
  const h = $derived(height ?? (kind === 'spark' ? 32 : 160));
  const hasData = $derived(hasAnyData(series));
  const merged = $derived(mergeSeries(series, maxPoints));
  const palette = $derived.by(() => { void theme?.mode; return theme?.chart?.() ?? DEFAULT_PALETTE; });
  const label = $derived(ariaLabel ?? summaryLabel(series, unit, locale, t));

  let mod = $state<PlotModule | undefined>();
  let failed = $state(false);
  let ready = $state(false);
  let loading = false;
  let host: HTMLElement | undefined = $state();
  let plotEl: HTMLElement | undefined = $state();
  let tipEl: HTMLElement | undefined = $state();

  let plot: PlotLike | undefined;
  let width = 0;
  let plotData: unknown;
  let appliedPalette: ChartPalette | undefined;

  // Load uPlot lazily, and only when there is something to draw.
  $effect(() => {
    if (!hasData || mod || failed || loading) return;
    loading = true;
    (loadPlot ?? defaultLoadPlot)().then((m) => { mod = m; }, () => { failed = true; }).finally(() => { loading = false; });
  });

  function onCursor(u: any): void {
    const tip = tipEl;
    if (!tip) return;
    const idx = u.cursor?.idx;
    if (idx == null || u.cursor.left < 0) { tip.hidden = true; return; }
    const m = tooltipModel(u.data, idx, series.map((s) => s.label), palette, unit, locale, timeZone);
    if (!m) { tip.hidden = true; return; }
    renderTooltip(tip, m);
    tip.hidden = false;
    const over = u.over as HTMLElement | undefined;
    const maxW = (host?.clientWidth || width || 0) - tip.offsetWidth;
    const maxH = (host?.clientHeight || h) - tip.offsetHeight;
    const left = (over?.offsetLeft ?? 0) + u.cursor.left + 12;
    const top = (over?.offsetTop ?? 0) + (u.cursor.top ?? 0) + 12;
    const x = left > maxW ? left - tip.offsetWidth - 24 : left;
    tip.style.left = `${Math.max(0, Math.min(x, Math.max(0, maxW)))}px`;
    tip.style.top = `${Math.max(0, Math.min(top, Math.max(0, maxH)))}px`;
  }

  // Create the plot; re-create only when kind/height/locale/unit change or the module arrives.
  $effect(() => {
    const M = mod;
    const el = plotEl;
    const k = kindD;
    const ht = h;
    void localeD; void zoneD; void unitD;
    if (!M || !el || !hasData) return;
    return untrack(() => {
      const data = merged;
      const opts = buildOptions({
        kind: k, labels: series.map((s) => s.label), palette, unit, width: width || el.clientWidth || 300, height: ht,
        locale, timeZone, mod: M, reducedEffects: prefersReducedEffects(), onCursor,
      });
      plotData = data;
      appliedPalette = palette;
      const p = new M(opts, [data.x, ...data.ys], el);
      plot = p;
      ready = true;
      return () => { p.destroy(); plot = undefined; ready = false; };
    });
  });

  // New data -> setData on the existing plot.
  $effect(() => {
    const data = merged;
    untrack(() => {
      if (!plot || data === plotData) return;
      plotData = data;
      plot.setData([data.x, ...data.ys]);
    });
  });

  // Palette / mode change -> recolour in place (no re-creation, no data re-processing).
  $effect(() => {
    const p = palette;
    untrack(() => {
      if (!plot || p === appliedPalette) return;
      appliedPalette = p;
      applyPalette(plot, kind, p);
    });
  });

  // Width follows the container, debounced to one frame; the plot is resized, not re-created.
  $effect(() => {
    const el = host;
    const RO = resizeObserver ?? (typeof ResizeObserver === 'undefined' ? undefined : ResizeObserver);
    if (!el || !RO) return;
    let raf = 0;
    const ro = new RO((entries) => {
      const w = Math.round(entries[entries.length - 1]?.contentRect.width ?? 0);
      if (w <= 0 || w === width) return;
      width = w;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        plot?.setSize({ width, height: untrack(() => h) });
      });
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  });
</script>

{#if !hasData}
  <Empty text={t('chart.empty', 'No data yet')} />
{:else if failed}
  <Empty text={t('chart.failed', 'Chart unavailable')} />
{:else}
  <div
    class="dash-chart"
    role="img"
    aria-label={label}
    data-no-swipe={kind === 'spark' ? undefined : ''}
    style:height="{h}px"
    bind:this={host}
  >
    <div class="plot" bind:this={plotEl}></div>
    {#if !ready}<div class="placeholder"></div>{/if}
    <div class="tip" bind:this={tipEl} hidden aria-hidden="true"></div>
  </div>
{/if}

<style>
  .dash-chart { position: relative; width: 100%; overflow: hidden; touch-action: pan-y; }
  .plot, .placeholder { width: 100%; height: 100%; }
  .placeholder { position: absolute; inset: 0; }
  .tip {
    position: absolute; z-index: 2; pointer-events: none; font-size: 0.75rem; line-height: 1.3; padding: 0.3rem 0.45rem;
    border-radius: 0.35rem; white-space: nowrap; background: var(--db-surface, #fff); color: var(--db-text, #1a1f27);
    border: 1px solid var(--db-border, #d9dde3); box-shadow: 0 2px 6px rgb(0 0 0 / 0.15);
  }
  .tip :global(.tip-time) { color: var(--db-muted, #4a5260); margin-bottom: 0.15rem; }
  .tip :global(.tip-swatch) { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 2px; margin-right: 0.35rem; }
</style>
