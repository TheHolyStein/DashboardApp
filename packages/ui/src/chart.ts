import type { ChartPalette, Translate } from '@dash/contract';

/** Svelte context key under which the theme engine provides `{ chart(), mode }`. */
export const THEME_KEY = 'dash:theme';

export type ChartKind = 'line' | 'area' | 'bar' | 'spark';
export type Point = [t: number, v: number | null];
export interface ChartSeries { label: string; points: Point[] }

/** Neutral palette, derived from the fallbacks of the `--db-*` tokens (canvas cannot resolve `var()`). */
export const DEFAULT_PALETTE: ChartPalette = {
  series: ['#2563eb', '#d97706', '#059669', '#db2777', '#7c3aed', '#0891b2'],
  grid: '#e3e6ea',
  axis: '#4a5260',
  fill: 0.18,
  lineWidth: 2,
  glow: false,
};

// ---------------------------------------------------------------- downsampling

const isGap = (p: Point): boolean => p[1] === null || !Number.isFinite(p[1]);

function lttb(run: Point[], target: number): Point[] {
  const n = run.length;
  if (target >= n) return run.slice();
  if (target < 3) return [run[0] as Point, run[n - 1] as Point];
  const out: Point[] = [run[0] as Point];
  const every = (n - 2) / (target - 2);
  let a = 0;
  for (let i = 0; i < target - 2; i++) {
    const nextStart = Math.floor((i + 1) * every) + 1;
    const nextEnd = Math.min(Math.floor((i + 2) * every) + 1, n);
    let avgX = 0;
    let avgY = 0;
    for (let j = nextStart; j < nextEnd; j++) { avgX += (run[j] as Point)[0]; avgY += (run[j] as Point)[1] as number; }
    const len = Math.max(nextEnd - nextStart, 1);
    avgX /= len; avgY /= len;
    const start = Math.floor(i * every) + 1;
    const end = Math.floor((i + 1) * every) + 1;
    const pa = run[a] as Point;
    let best = -1;
    let pick = start;
    for (let j = start; j < end; j++) {
      const p = run[j] as Point;
      const area = Math.abs((pa[0] - avgX) * ((p[1] as number) - (pa[1] as number)) - (pa[0] - p[0]) * (avgY - (pa[1] as number)));
      if (area > best) { best = area; pick = j; }
    }
    out.push(run[pick] as Point);
    a = pick;
  }
  out.push(run[n - 1] as Point);
  return out;
}

/**
 * Largest-triangle-three-buckets. Keeps first and last point; returns the input unchanged when it already fits.
 * `null` values are gaps: each contiguous non-null run is reduced on its own (budget shared by length), gaps are kept
 * (consecutive gap points collapse to one). Pure: never mutates the input.
 * Assumes timestamps are ascending (as the module data contract requires).
 */
export function downsample(points: Point[], maxPoints: number): Point[] {
  if (points.length <= maxPoints) return points;
  if (maxPoints < 2) return [points[0] as Point, points[points.length - 1] as Point];
  const runs: Array<Point[] | Point> = [];
  let cur: Point[] | null = null;
  let nonNull = 0;
  let gaps = 0;
  for (const p of points) {
    if (isGap(p)) {
      cur = null;
      const prev = runs[runs.length - 1];
      if (!prev || Array.isArray(prev[0])) { runs.push([p[0], null] as Point); gaps++; } // prev is a run (array of points)
    } else {
      if (!cur) { cur = []; runs.push(cur); }
      cur.push(p);
      nonNull++;
    }
  }
  const budget = Math.max(2, maxPoints - gaps);
  const out: Point[] = [];
  for (const r of runs) {
    if (!Array.isArray(r[0])) { out.push(r as Point); continue; }
    const run = r as Point[];
    for (const q of lttb(run, Math.max(2, Math.floor((budget * run.length) / nonNull)))) out.push(q);
  }
  return out;
}

// ---------------------------------------------------------------- data

/** `undefined` = alignment hole (series has no sample at this x; uPlot bridges it), `null` = real gap. */
export type YValue = number | null | undefined;
export interface Merged { x: number[]; ys: YValue[][] }

function sameTimestamps(series: ChartSeries[]): boolean {
  const first = series[0]?.points;
  if (!first || series.length < 2) return false;
  return series.every((s) => {
    if (s.points.length !== first.length) return false;
    for (let i = 0; i < first.length; i++) if ((s.points[i] as Point)[0] !== (first[i] as Point)[0]) return false;
    return true;
  });
}

/**
 * Downsample every series and align them on one sorted x axis in epoch SECONDS (uPlot's unit).
 * Series sharing identical timestamps are reduced on one shared selection (LTTB on the series with most data), so
 * they stay aligned without holes. Otherwise holes are `undefined`; only real gaps are `null`.
 */
export function mergeSeries(series: ChartSeries[], maxPoints: number): Merged {
  let reduced: Point[][];
  if (sameTimestamps(series) && (series[0] as ChartSeries).points.length > maxPoints) {
    let rep = series[0] as ChartSeries;
    let best = -1;
    for (const s of series) {
      const n = s.points.reduce((c, p) => c + (isGap(p) ? 0 : 1), 0);
      if (n > best) { best = n; rep = s; }
    }
    const keep = new Set<number>();
    for (const p of downsample(rep.points, maxPoints)) keep.add(p[0]);
    reduced = series.map((s) => s.points.filter((p) => keep.has(p[0])));
  } else {
    reduced = series.map((s) => downsample(s.points, maxPoints));
  }
  const set = new Set<number>();
  for (const pts of reduced) for (const p of pts) set.add(p[0]);
  const xms = [...set].sort((a, b) => a - b);
  const ys = reduced.map((pts) => {
    const m = new Map<number, number | null>();
    for (const p of pts) m.set(p[0], isGap(p) ? null : p[1]);
    return xms.map((t): YValue => (m.has(t) ? (m.get(t) as number | null) : undefined));
  });
  return { x: xms.map((t) => t / 1000), ys };
}

/** Cheap change detector for merged data: shape, extremes and a rolling sum (no deep compare). */
export function dataSignature(m: Merged): string {
  const parts: Array<string | number> = [m.ys.length, m.x.length, m.x[0] ?? '', m.x[m.x.length - 1] ?? ''];
  for (const ys of m.ys) {
    let sum = 0;
    for (const v of ys) sum = typeof v === 'number' ? (sum * 31 + v) % 1e12 : sum + (v === null ? 7 : 3);
    parts.push(ys.length, ys[ys.length - 1] ?? 'u', sum);
  }
  return parts.join('|');
}

export const hasAnyData = (series: ChartSeries[]): boolean => series.some((s) => s.points.some((p) => !isGap(p)));

export function latest(points: Point[]): number | null {
  for (let i = points.length - 1; i >= 0; i--) { const p = points[i] as Point; if (!isGap(p)) return p[1]; }
  return null;
}

// ---------------------------------------------------------------- colours

export function withAlpha(color: string, alpha: number): string {
  const a = Math.min(1, Math.max(0, alpha));
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (m) {
    let h = m[1] as string;
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return `color-mix(in srgb, ${color} ${Math.round(a * 100)}%, transparent)`;
}

export const seriesColor = (p: ChartPalette, i: number): string => {
  const list = p.series.length ? p.series : DEFAULT_PALETTE.series;
  return list[i % list.length] as string;
};

function fillFor(kind: ChartKind, p: ChartPalette, i: number): string | undefined {
  const c = seriesColor(p, i);
  if (kind === 'area') return withAlpha(c, p.fill);
  if (kind === 'bar') return withAlpha(c, 0.85);
  return undefined;
}

// ---------------------------------------------------------------- formatting

export function makeNumberFormat(locale?: string): (v: number) => string {
  let nf: Intl.NumberFormat;
  try { nf = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }); } catch { nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }); }
  return (v) => nf.format(v);
}

export function formatValue(v: number | null, unit: string | undefined, fmt: (v: number) => string): string {
  return v === null ? '–' : `${fmt(v)}${unit ?? ''}`;
}

function dateFmt(locale: string | undefined, timeZone: string | undefined, o: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try { return new Intl.DateTimeFormat(locale, { ...o, timeZone }); } catch { return new Intl.DateTimeFormat(undefined, o); }
}

/** Tick labels for a time axis (splits in epoch seconds), granularity chosen from the visible span. */
export function timeTickLabels(splits: number[], locale?: string, timeZone?: string): string[] {
  const span = splits.length > 1 ? (splits[splits.length - 1] as number) - (splits[0] as number) : 0;
  const o: Intl.DateTimeFormatOptions =
    span <= 2 * 86400 ? { hour: 'numeric', minute: '2-digit' }
    : span <= 60 * 86400 ? { month: 'short', day: 'numeric' }
    : { month: 'short', year: 'numeric' };
  const f = dateFmt(locale, timeZone, o);
  return splits.map((s) => f.format(new Date(s * 1000)));
}

export function formatTooltipTime(sec: number, locale?: string, timeZone?: string): string {
  return dateFmt(locale, timeZone, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(sec * 1000));
}

export interface TooltipModel { time: string; rows: Array<{ label: string; value: string; color: string }> }

export function tooltipModel(
  data: Array<YValue[] | number[]>, idx: number, labels: string[], palette: ChartPalette,
  unit: string | undefined, locale?: string, timeZone?: string,
): TooltipModel | null {
  const x = data[0]?.[idx];
  if (typeof x !== 'number') return null;
  const fmt = makeNumberFormat(locale);
  return {
    time: formatTooltipTime(x, locale, timeZone),
    // Alignment holes (undefined) show nothing; real gaps (null) show a dash.
    rows: labels.flatMap((label, i) => {
      const v = data[i + 1]?.[idx];
      return v === undefined ? [] : [{ label, value: formatValue(v, unit, fmt), color: seriesColor(palette, i) }];
    }),
  };
}

/** Fills `el` using text nodes only (labels are data, never HTML). */
export function renderTooltip(el: HTMLElement, m: TooltipModel): void {
  el.replaceChildren();
  const doc = el.ownerDocument;
  const head = doc.createElement('div');
  head.className = 'tip-time';
  head.appendChild(doc.createTextNode(m.time));
  el.appendChild(head);
  for (const r of m.rows) {
    const row = doc.createElement('div');
    row.className = 'tip-row';
    const sw = doc.createElement('span');
    sw.className = 'tip-swatch';
    sw.style.background = r.color;
    row.appendChild(sw);
    row.appendChild(doc.createTextNode(`${r.label}: ${r.value}`));
    el.appendChild(row);
  }
}

export function summaryLabel(series: ChartSeries[], unit: string | undefined, locale: string | undefined, t: Translate): string {
  const fmt = makeNumberFormat(locale);
  const list = series.map((s) => `${s.label} ${formatValue(latest(s.points), unit, fmt)}`).join(', ');
  return t('chart.summary', 'Chart, {count} series. Latest: {list}', { count: series.length, list });
}

// ---------------------------------------------------------------- plot abstraction & options

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- uPlot options/instances are loosely typed by design */
/** The subset of uPlot the wrapper uses; tests provide a fake. */
export interface PlotLike {
  setData(data: Array<YValue[] | number[]>, resetScales?: boolean): void;
  setCursor?(pos: { left: number; top: number }): void;
  over?: HTMLElement;
  setSize(size: { width: number; height: number }): void;
  redraw(rebuildPaths?: boolean, recalcAxes?: boolean): void;
  destroy(): void;
  series: Array<Record<string, any>>;
  axes: Array<Record<string, any>>;
}
export interface PlotModule {
  new (opts: any, data: any, target: HTMLElement): PlotLike;
  tzDate?: (d: Date, tz: string) => Date;
  paths?: { bars?: (o?: any) => unknown };
}
export type LoadPlot = () => Promise<PlotModule>;

export const defaultLoadPlot: LoadPlot = async () => {
  // @ts-expect-error -- CSS side-effect import; the bundler emits it into the same lazy chunk as uPlot
  const [mod] = await Promise.all([import('uplot'), import('uplot/dist/uPlot.min.css')]);
  return mod.default as unknown as PlotModule;
};

export interface BuildInput {
  kind: ChartKind; labels: string[]; palette: ChartPalette; unit?: string | undefined; width: number; height: number;
  locale?: string | undefined; timeZone?: string | undefined; mod?: PlotModule | undefined;
  /** Mutable holder read at draw time; `applyPalette` updates it so glow follows palette changes without re-creation. */
  live?: LivePalette;
  /** Called with the uPlot instance when the cursor moves (non-spark). */
  onCursor?: (u: any) => void;
}

export interface LivePalette { palette: ChartPalette; reduced: () => boolean }

export function prefersReducedEffects(): boolean {
  try {
    return typeof matchMedia === 'function' && (matchMedia('(prefers-reduced-motion: reduce)').matches || matchMedia('(prefers-contrast: more)').matches);
  } catch { return false; }
}

export function buildOptions(b: BuildInput): Record<string, any> {
  const { kind, palette: p } = b;
  const spark = kind === 'spark';
  const fmt = makeNumberFormat(b.locale);
  const live = b.live ?? { palette: p, reduced: prefersReducedEffects };
  const bars = kind === 'bar' ? b.mod?.paths?.bars?.({ size: [0.8, 64] }) : undefined;
  const series: Array<Record<string, unknown>> = [{}];
  b.labels.forEach((label, i) => {
    const s: Record<string, unknown> = {
      label, stroke: seriesColor(p, i), width: p.lineWidth, points: { show: false }, spanGaps: false,
    };
    const f = fillFor(kind, p, i);
    if (f) s.fill = f;
    if (bars) s.paths = bars;
    series.push(s);
  });
  const hooks: Record<string, unknown[]> = {};
  if (!spark) {
    // drawSeries fires after each series, so set the shadow before series (drawAxes) and clear it afterwards.
    // Glow is decided at draw time from the live palette and the reduced-effects preference.
    hooks.drawAxes = [(u: any) => {
      if (live.palette.glow && !live.reduced()) { u.ctx.shadowBlur = 6; u.ctx.shadowColor = seriesColor(live.palette, 0); }
    }];
    hooks.draw = [(u: any) => { u.ctx.shadowBlur = 0; }];
  }
  if (!spark && b.onCursor) hooks.setCursor = [b.onCursor];
  const opts: Record<string, any> = {
    width: b.width, height: b.height, series, hooks,
    legend: { show: false },
    scales: { x: { time: true }, y: kind === 'bar' || kind === 'area' ? { range: (_u: unknown, min: number, max: number) => [Math.min(0, min), Math.max(0, max) || 1] } : {} },
  };
  if (b.timeZone && b.mod?.tzDate) { const tz = b.timeZone; const td = b.mod.tzDate; opts.tzDate = (ts: number) => td(new Date(ts * 1000), tz); }
  if (spark) {
    opts.padding = [0, 0, 0, 0];
    opts.cursor = { show: false };
    opts.axes = [{ show: false }, { show: false }];
  } else {
    opts.cursor = { drag: { x: false, y: false, setScale: false }, points: { size: 6 } };
    const base = (): Record<string, any> => ({
      stroke: p.axis, grid: { stroke: p.grid, width: 1 }, ticks: { stroke: p.grid, width: 1 }, border: { show: false },
    });
    opts.axes = [
      { ...base(), values: (_u: unknown, splits: number[]) => timeTickLabels(splits, b.locale, b.timeZone) },
      { ...base(), values: (_u: unknown, splits: number[]) => splits.map((v) => `${fmt(v)}${b.unit ?? ''}`) },
    ];
  }
  return opts;
}

/** Recolour an existing plot in place (uPlot converts colour options to functions on init, so assign functions). */
export function applyPalette(plot: PlotLike, kind: ChartKind, p: ChartPalette, live?: LivePalette): void {
  if (live) live.palette = p;
  for (let i = 1; i < plot.series.length; i++) {
    const s = plot.series[i] as Record<string, any>;
    const c = seriesColor(p, i - 1);
    s.stroke = () => c;
    s.width = p.lineWidth;
    const f = fillFor(kind, p, i - 1);
    if (f) s.fill = () => f;
  }
  if (kind !== 'spark') {
    for (const a of plot.axes) {
      if (a.show === false) continue;
      a.stroke = () => p.axis;
      if (a.grid) a.grid.stroke = () => p.grid;
      if (a.ticks) a.ticks.stroke = () => p.grid;
    }
  }
  plot.redraw(true, false);
}
