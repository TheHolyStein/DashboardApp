/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- fake plot mirrors uPlot's loose option shapes */
import { flushSync } from 'svelte';
import { render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChartPalette } from '@dash/contract';
import { Chart, downsample } from '../src/index.js';
import { DEFAULT_PALETTE, THEME_KEY, mergeSeries, type Point, type PlotModule } from '../src/chart.js';
import { makeThemeSeam } from './chart-theme.svelte.js';

class FakePlot {
  static instances: FakePlot[] = [];
  static paths = { bars: () => 'bars-path' };
  opts: any;
  data: any;
  series: any[];
  axes: any[];
  setData = vi.fn((d: unknown) => { this.data = d; });
  setSize = vi.fn();
  redraw = vi.fn();
  destroy = vi.fn();
  constructor(opts: any, data: unknown, public target: HTMLElement) {
    this.opts = opts;
    this.data = data;
    this.series = opts.series.map((s: any) => ({ ...s, stroke: () => s.stroke, fill: () => s.fill }));
    this.axes = (opts.axes ?? []).map((a: any) => ({ ...a, grid: { ...a.grid }, ticks: { ...a.ticks } }));
    FakePlot.instances.push(this);
  }
}
const fakeModule = FakePlot as unknown as PlotModule;
const loadPlot = () => Promise.resolve(fakeModule);

class FakeRO {
  static all: FakeRO[] = [];
  disconnect = vi.fn();
  observe = vi.fn();
  constructor(public cb: (e: Array<{ contentRect: { width: number } }>) => void) { FakeRO.all.push(this); }
  fire(width: number) { this.cb([{ contentRect: { width } }]); }
}
const RO = FakeRO as unknown as typeof ResizeObserver;

const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);
const pts = (vals: Array<number | null>, step = 60_000): Point[] => vals.map((v, i) => [T0 + i * step, v]);
const lastPlot = () => FakePlot.instances[FakePlot.instances.length - 1] as FakePlot;
const pal = (colors: string[], extra: Partial<ChartPalette> = {}): ChartPalette => ({ ...DEFAULT_PALETTE, series: colors, ...extra });

beforeEach(() => { FakePlot.instances = []; FakeRO.all = []; });
afterEach(() => vi.unstubAllGlobals());

async function mount(props: Record<string, unknown>, context?: Map<string, unknown>) {
  const r = render(Chart, { props: { kind: 'line', loadPlot, resizeObserver: RO, ...props } as never, ...(context ? { context } : {}) });
  await waitFor(() => expect(FakePlot.instances.length).toBe(1));
  return r;
}

describe('downsample', () => {
  const big = Array.from({ length: 1000 }, (_, i): Point => [i * 1000, Math.sin(i / 20) * 10]);

  it('downsample keeps first and last and returns ≤ max', () => {
    const out = downsample(big, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out[0]).toEqual(big[0]);
    expect(out[out.length - 1]).toEqual(big[999]);
  });

  it('returns the input when already short enough', () => {
    const short = big.slice(0, 50);
    expect(downsample(short, 300)).toBe(short);
  });

  it('never mutates the input and is deterministic', () => {
    const copy = JSON.parse(JSON.stringify(big));
    const a = downsample(big, 120);
    expect(big).toEqual(copy);
    expect(downsample(big, 120)).toEqual(a);
  });

  it('keeps gaps and reduces each run', () => {
    const data: Point[] = [...pts(Array.from({ length: 500 }, (_, i) => i % 7), 1000), [T0 + 600_000, null], ...pts(Array.from({ length: 500 }, (_, i) => i % 5), 1000).map(([t, v]): Point => [t + 700_000, v])];
    const out = downsample(data, 100);
    expect(out.filter((p) => p[1] === null)).toHaveLength(1);
    const gapAt = out.findIndex((p) => p[1] === null);
    expect(gapAt).toBeGreaterThan(1);
    expect(gapAt).toBeLessThan(out.length - 2);
    expect(out[0]).toEqual(data[0]);
    expect(out[out.length - 1]).toEqual(data[data.length - 1]);
  });

  it('keeps the extremes of a spike', () => {
    const flat = Array.from({ length: 1000 }, (_, i): Point => [i, i === 503 ? 1000 : 1]);
    expect(downsample(flat, 50).some((p) => p[1] === 1000)).toBe(true);
  });
});

describe('mergeSeries', () => {
  it('series with different timestamps are merged with null fill', () => {
    const m = mergeSeries([
      { label: 'a', points: [[1000, 1], [3000, 3]] },
      { label: 'b', points: [[2000, 20], [3000, 30]] },
    ], 300);
    expect(m.x).toEqual([1, 2, 3]);
    expect(m.ys).toEqual([[1, null, 3], [null, 20, 30]]);
  });
});

describe('Chart', () => {
  it('empty series shows Empty', () => {
    const spy = vi.fn(loadPlot);
    render(Chart, { props: { kind: 'line', series: [{ label: 'a', points: pts([null, null]) }], loadPlot: spy, resizeObserver: RO } });
    expect(screen.getByText('No data yet')).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it('failed loadPlot shows the failure Empty', async () => {
    render(Chart, { props: { kind: 'line', series: [{ label: 'a', points: pts([1, 2]) }], loadPlot: () => Promise.reject(new Error('x')), resizeObserver: RO } });
    await waitFor(() => expect(screen.getByText('Chart unavailable')).toBeTruthy());
  });

  it('new data calls setData on the same plot instance', async () => {
    const r = await mount({ series: [{ label: 'a', points: pts([1, 2, 3]) }] });
    await r.rerender({ series: [{ label: 'a', points: pts([4, 5, 6, 7]) }] });
    flushSync();
    expect(FakePlot.instances).toHaveLength(1);
    expect(lastPlot().setData).toHaveBeenCalledTimes(1);
    expect((lastPlot().data[1] as number[]).length).toBe(4);
  });

  it('palette change updates series colours', async () => {
    const seam = makeThemeSeam(pal(['#111111', '#222222']));
    await mount({ series: [{ label: 'a', points: pts([1, 2]) }, { label: 'b', points: pts([2, 3]) }] }, new Map([[THEME_KEY, seam]]));
    const p = lastPlot();
    expect(p.opts.series[1].stroke).toBe('#111111');
    seam.set(pal(['#aa0000', '#00bb00'], { lineWidth: 3 }), 'night');
    flushSync();
    expect(FakePlot.instances).toHaveLength(1);
    expect(p.setData).not.toHaveBeenCalled();
    expect(p.series[1].stroke()).toBe('#aa0000');
    expect(p.series[2].stroke()).toBe('#00bb00');
    expect(p.axes[0].stroke()).toBe(DEFAULT_PALETTE.axis);
    expect(p.redraw).toHaveBeenCalled();
  });

  it('without a theme context the neutral palette is used', async () => {
    await mount({ series: [{ label: 'a', points: pts([1, 2]) }] });
    expect(lastPlot().opts.series[1].stroke).toBe(DEFAULT_PALETTE.series[0]);
  });

  it('area fill uses palette.fill as opacity of the series colour', async () => {
    await mount({ kind: 'area', series: [{ label: 'a', points: pts([1, 2]) }] });
    expect(lastPlot().opts.series[1].fill).toBe('rgba(37, 99, 235, 0.18)');
  });

  it('resize calls setSize once per frame', async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    await mount({ series: [{ label: 'a', points: pts([1, 2]) }] });
    const ro = FakeRO.all[0] as FakeRO;
    ro.fire(400); ro.fire(420); ro.fire(440);
    expect(frames).toHaveLength(1);
    frames[0]?.(0);
    expect(lastPlot().setSize).toHaveBeenCalledTimes(1);
    expect(lastPlot().setSize).toHaveBeenCalledWith({ width: 440, height: 160 });
    expect(FakePlot.instances).toHaveLength(1);
  });

  it('unmount calls destroy and disconnects the observer', async () => {
    const r = await mount({ series: [{ label: 'a', points: pts([1, 2]) }] });
    r.unmount();
    expect(lastPlot().destroy).toHaveBeenCalledTimes(1);
    expect((FakeRO.all[0] as FakeRO).disconnect).toHaveBeenCalled();
  });

  it('spark options have no axes and no cursor', async () => {
    const { container } = await mount({ kind: 'spark', series: [{ label: 'a', points: pts([1, 2]) }] });
    const o = lastPlot().opts;
    expect(o.axes.every((a: any) => a.show === false)).toBe(true);
    expect(o.cursor.show).toBe(false);
    expect(o.height).toBe(32);
    expect(container.querySelector('[data-no-swipe]')).toBeNull();
  });

  it('line charts are marked data-no-swipe', async () => {
    const { container } = await mount({ series: [{ label: 'a', points: pts([1, 2]) }] });
    expect(container.querySelector('[data-no-swipe]')).toBeTruthy();
  });

  it('the tooltip renders a label containing <b> as literal text', async () => {
    const { container } = await mount({ series: [{ label: '<b>x</b>', points: pts([1, 2]) }], unit: '%' });
    const hook = lastPlot().opts.hooks.setCursor[0];
    hook({ cursor: { idx: 1, left: 10, top: 5 }, data: lastPlot().data, over: undefined });
    const tip = container.querySelector('.tip') as HTMLElement;
    expect(tip.hidden).toBe(false);
    expect(tip.querySelector('b')).toBeNull();
    expect(tip.textContent).toContain('<b>x</b>: 2%');
    expect(tip.getAttribute('aria-hidden')).toBe('true');
    hook({ cursor: { idx: null, left: -10, top: -10 }, data: lastPlot().data });
    expect(tip.hidden).toBe(true);
  });

  it('the generated aria-label contains the latest value and unit', async () => {
    const { container } = await mount({ series: [{ label: 'CPU', points: pts([10, 42.5, null]) }], unit: '%' });
    const label = container.querySelector('[role="img"]')?.getAttribute('aria-label') ?? '';
    expect(label).toContain('CPU');
    expect(label).toContain('42.5%');
  });

  it('uses the ariaLabel prop when given', async () => {
    const { container } = await mount({ series: [{ label: 'a', points: pts([1, 2]) }], ariaLabel: 'Load' });
    expect(container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Load');
  });
});
