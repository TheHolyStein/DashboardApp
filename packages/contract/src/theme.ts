import type { Component } from 'svelte';
import type { z } from 'zod';
import type { WeatherCondition } from './events.js';
import type { TileProps } from './client.js';
import { ID_RE, type Intensity, type Mode, type ModuleId, type ThemeId, type TileSize } from './ids.js';
import { SEMVER_RE } from './manifest.js';

export const ICON_KEYS = ['settings','close','edit','add','remove','drag','resize','bell','user','day','night','warn','ok','stale',
  'clock','calendar','todo','weather','network','nas','server','rss','moon','stocks','art','github','wled','link','note','habit','timer','launch'] as const;
export type IconKey = (typeof ICON_KEYS)[number];
export interface SceneEnv { sunAltitudeDeg: number | null; weather: z.infer<typeof WeatherCondition> | null; moonPhase: number | null; now: Date }
export interface BackgroundProps { mode: Mode; intensity: Intensity; env: SceneEnv }
export interface ClockFaceProps { now: Date; mode: Mode; size: TileSize; showSeconds: boolean; hour12: boolean; timeZone: string; label?: string }
export interface ChartPalette { series: string[]; grid: string; axis: string; fill: number /* 0..1 area opacity */; lineWidth: number; glow: boolean }
export interface PaneTransition { durationMs: number; in: string; out: string }   // CSS animation names defined in the theme's css
type Lazy<T> = () => Promise<{ default: T }>;
export interface ThemeManifest {
  id: ThemeId; name: string; version: string; description: string;
  css: string[];                                         // paths relative to theme folder; tokens.css first
  backgrounds: Array<{ id: string; name: string; component: Lazy<Component<BackgroundProps>>; staticImage: string }>;   // ≥ 1
  clockFaces:  Array<{ id: string; name: string; component: Lazy<Component<ClockFaceProps>> }>;                        // ≥ 1
  icons: Partial<Record<IconKey | string, string>>; // eslint-disable-line @typescript-eslint/no-redundant-type-constituents -- svg strings; keeps IconKey autocomplete while allowing module-provided keys
  strings: Record<string /* locale */, Record<string, string>>;   // overrides for t() keys
  chart: Record<Mode, ChartPalette>;
  pane: PaneTransition;
  tiles?: Record<ModuleId, Lazy<Component<TileProps<any, any>>>>; // eslint-disable-line @typescript-eslint/no-explicit-any -- optional full tile overrides are generic over arbitrary data
}

const MIN_CHART_SERIES = 6;
const MAX_PANE_MS = 400;

// Returns human-readable problems; [] means valid.
export function validateTheme(m: ThemeManifest): string[] {
  const problems: string[] = [];

  if (!ID_RE.test(m.id)) problems.push(`id "${m.id}" does not match ${ID_RE}`);
  if (!SEMVER_RE.test(m.version)) problems.push(`version "${m.version}" is not semver`);

  if (!m.css[0]?.endsWith('tokens.css')) problems.push('css[0] must be tokens.css');

  if (m.backgrounds.length < 1) problems.push('theme needs at least one background');
  for (const bg of m.backgrounds) {
    if (!bg.staticImage) problems.push(`background "${bg.id}" needs a staticImage`);
  }
  const bgIds = m.backgrounds.map(b => b.id);
  if (new Set(bgIds).size !== bgIds.length) problems.push('duplicate background ids');

  if (m.clockFaces.length < 1) problems.push('theme needs at least one clock face');
  const faceIds = m.clockFaces.map(f => f.id);
  if (new Set(faceIds).size !== faceIds.length) problems.push('duplicate clock face ids');

  for (const mode of ['day', 'night'] as const) {
    const n = m.chart[mode].series.length;
    if (n < MIN_CHART_SERIES) problems.push(`chart.${mode} needs at least ${MIN_CHART_SERIES} series colors (has ${n})`);
  }

  if (m.pane.durationMs > MAX_PANE_MS) problems.push(`pane durationMs ${m.pane.durationMs} exceeds ${MAX_PANE_MS}`);

  return problems;
}
