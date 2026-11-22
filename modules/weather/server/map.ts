import { DashError, type EventPayload } from '@dash/contract';
import {
  POLLEN_TYPES,
  type AqiBand,
  type Condition,
  type DetailData,
  type Forecast as ForecastSnapshot,
  type PollenLevel,
  type PollenType,
  type Settings,
} from '../manifest.js';
import type { Air, Forecast } from './openmeteo.js';

const HOUR_MS = 3_600_000;
const DAY_S = 86_400;

/** WMO weather interpretation codes (Open-Meteo `weather_code`) to the condition set. The one place that knows the codes. */
export const WMO_TABLE: ReadonlyArray<{ from: number; to: number; condition: Condition }> = [
  { from: 0, to: 1, condition: 'clear' },
  { from: 2, to: 3, condition: 'cloudy' },
  { from: 45, to: 45, condition: 'fog' },
  { from: 48, to: 48, condition: 'fog' },
  { from: 51, to: 57, condition: 'drizzle' },
  { from: 61, to: 67, condition: 'rain' },
  { from: 71, to: 77, condition: 'snow' },
  { from: 80, to: 82, condition: 'rain' },
  { from: 85, to: 86, condition: 'snow' },
  { from: 95, to: 99, condition: 'storm' },
];

/** Codes the table does not know (the API documents none, but a new one must not break the tile) read as cloudy. */
export function conditionFromWmo(code: number): Condition {
  return WMO_TABLE.find((r) => code >= r.from && code <= r.to)?.condition ?? 'cloudy';
}

/**
 * Pollen level limits in grains/m³: a value above the n-th limit is at least level n (levels 1 to 5).
 * Trees (alder, birch, olive) and the herbaceous types (grass, mugwort, ragweed) have their own scales.
 */
export const POLLEN_THRESHOLDS = {
  tree: [0, 10, 50, 200, 700],
  herb: [0, 5, 20, 50, 150],
} as const;
const POLLEN_SCALE: Record<PollenType, keyof typeof POLLEN_THRESHOLDS> = {
  alder: 'tree',
  birch: 'tree',
  olive: 'tree',
  grass: 'herb',
  mugwort: 'herb',
  ragweed: 'herb',
};

export function pollenLevel(type: string, grainsPerM3: number): PollenLevel {
  const scale = POLLEN_SCALE[type as PollenType];
  if (!scale) return 0;
  const limits = POLLEN_THRESHOLDS[scale];
  let level = 0;
  for (const limit of limits) if (grainsPerM3 > limit) level++;
  return level as PollenLevel;
}

/** European AQI: up to 20 good, 40 fair, 60 moderate, 80 poor, above that very poor. */
export const AQI_LIMITS = [20, 40, 60, 80] as const;
const AQI_BANDS: readonly AqiBand[] = ['good', 'fair', 'moderate', 'poor', 'very-poor'];
export function aqiBand(aqi: number): AqiBand {
  const i = AQI_LIMITS.findIndex((limit) => aqi <= limit);
  return AQI_BANDS[i === -1 ? AQI_LIMITS.length : i] as AqiBand;
}

const iso = (epochS: number): string => new Date(epochS * 1000).toISOString();
const localDay = (epochS: number, offsetS: number): number => Math.floor((epochS + offsetS) / DAY_S);
const localDate = (epochS: number, offsetS: number): string => new Date((epochS + offsetS) * 1000).toISOString().slice(0, 10);

function need(v: number | null | undefined, what: string): number {
  if (v === null || v === undefined) throw new DashError('upstream', `forecast lacks ${what}`);
  return v;
}

function todayIndex(f: Forecast, now: Date): number {
  const today = localDay(now.getTime() / 1000, f.utc_offset_seconds);
  const i = f.daily.time.findIndex((t) => localDay(t, f.utc_offset_seconds) === today);
  if (i === -1) throw new DashError('upstream', 'forecast does not cover today');
  return i;
}

export interface PollenDays {
  dates: string[];
  types: Array<{ type: PollenType; levels: Array<PollenLevel | null> }>;
}

/** Highest hourly level of every day and type, over the days the air model delivered. A type without values is omitted. */
export function pollenByDay(air: Air, types: readonly PollenType[]): PollenDays {
  const offset = air.utc_offset_seconds;
  const dates: string[] = [];
  const dayOf: number[] = [];
  air.hourly.time.forEach((t, i) => {
    const date = localDate(t, offset);
    let d = dates.indexOf(date);
    if (d === -1) d = dates.push(date) - 1;
    dayOf[i] = d;
  });
  const out: PollenDays['types'] = [];
  for (const type of POLLEN_TYPES) {
    if (!types.includes(type)) continue;
    const values = air.hourly[`${type}_pollen`];
    if (!values) continue;
    const max: Array<number | null> = dates.map(() => null);
    values.forEach((v, i) => {
      const d = dayOf[i];
      if (v === null || v === undefined || d === undefined) return;
      max[d] = Math.max(max[d] ?? 0, v);
    });
    if (max.every((m) => m === null)) continue;
    out.push({ type, levels: max.map((m) => (m === null ? null : pollenLevel(type, m))) });
  }
  return { dates, types: out };
}

function airSummary(air: Air | null): { aqi: number; band: AqiBand } | null {
  const v = air?.current.european_aqi;
  if (v === null || v === undefined) return null;
  return { aqi: Math.round(v), band: aqiBand(v) };
}

export interface SnapshotInput {
  place: string;
  units: 'metric' | 'imperial';
  forecast: Forecast;
  /** null when the air model was not asked or did not answer. */
  air: Air | null;
  show: Settings['show'];
  pollenTypes: readonly PollenType[];
  now: Date;
}

/** Everything about the next 24 h that is not already history: the first hour with at least 0.2 mm. */
function nextPrecip(f: Forecast, now: Date): ForecastSnapshot['nextPrecip'] {
  const from = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const to = now.getTime() + 24 * HOUR_MS;
  for (let i = 0; i < f.hourly.time.length; i++) {
    const t = (f.hourly.time[i] as number) * 1000;
    if (t < from || t >= to) continue;
    const mm = f.hourly.precipitation[i];
    if (typeof mm === 'number' && mm >= 0.2) return { at: new Date(t).toISOString(), mm };
  }
  return null;
}

export function mapSnapshot(i: SnapshotInput): ForecastSnapshot {
  const { forecast: f, now } = i;
  const d = todayIndex(f, now);
  const pollen: ForecastSnapshot['pollen'] = [];
  if (i.show.pollen && i.air) {
    const days = pollenByDay(i.air, i.pollenTypes);
    const today = days.dates.indexOf(localDate(now.getTime() / 1000, i.air.utc_offset_seconds));
    if (today !== -1) {
      for (const row of days.types) {
        const level = row.levels[today];
        if (level !== null && level !== undefined) pollen.push({ type: row.type, level });
      }
    }
  }
  const uv = f.daily.uv_index_max[d];
  return {
    place: i.place,
    units: i.units,
    now: {
      tempC: f.current.temperature_2m,
      feelsC: f.current.apparent_temperature,
      condition: conditionFromWmo(f.current.weather_code),
      windKph: f.current.wind_speed_10m,
      humidity: f.current.relative_humidity_2m,
    },
    nextPrecip: nextPrecip(f, now),
    today: {
      minC: need(f.daily.temperature_2m_min[d], 'the minimum'),
      maxC: need(f.daily.temperature_2m_max[d], 'the maximum'),
      uvMax: i.show.uv && typeof uv === 'number' ? uv : null,
      sunrise: iso(need(f.daily.sunrise[d], 'sunrise')),
      sunset: iso(need(f.daily.sunset[d], 'sunset')),
    },
    pollen,
    air: i.show.air ? airSummary(i.air) : null,
  };
}

/**
 * The `weather.updated` payload for the home location. Built from everything the model knows, not from one tile's
 * settings, so a home tile that hides pollen or air does not change what other modules are told.
 */
export function weatherEvent(i: SnapshotInput): EventPayload<'weather.updated'> {
  const full = mapSnapshot({ ...i, show: { pollen: true, air: true, uv: true }, pollenTypes: POLLEN_TYPES });
  return {
    condition: full.now.condition,
    tempC: full.now.tempC,
    nextPrecip: full.nextPrecip,
    pollenMax: full.pollen.length > 0 ? Math.max(...full.pollen.map((p) => p.level)) : null,
    aqi: full.air?.aqi ?? null,
  };
}

export interface DetailInput {
  place: string;
  forecast: Forecast;
  air: Air | null;
  show: Settings['show'];
  pollenTypes: readonly PollenType[];
  now: Date;
}

export function mapDetail(i: DetailInput): DetailData {
  const { forecast: f, now } = i;
  const from = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const hourly: DetailData['hourly'] = [];
  for (let k = 0; k < f.hourly.time.length && hourly.length < 48; k++) {
    const t = (f.hourly.time[k] as number) * 1000;
    const tempC = f.hourly.temperature_2m[k];
    if (t < from || typeof tempC !== 'number') continue;
    hourly.push({ t, tempC, precipMm: f.hourly.precipitation[k] ?? 0, windKph: f.hourly.wind_speed_10m[k] ?? 0 });
  }
  const first = todayIndex(f, now);
  const daily: DetailData['daily'] = [];
  for (let k = first; k < f.daily.time.length; k++) {
    const uv = f.daily.uv_index_max[k];
    daily.push({
      date: localDate(f.daily.time[k] as number, f.utc_offset_seconds),
      condition: conditionFromWmo(f.daily.weather_code[k] ?? 3),
      minC: need(f.daily.temperature_2m_min[k], 'a minimum'),
      maxC: need(f.daily.temperature_2m_max[k], 'a maximum'),
      precipMm: f.daily.precipitation_sum[k] ?? 0,
      uvMax: i.show.uv && typeof uv === 'number' ? uv : null,
      sunrise: iso(need(f.daily.sunrise[k], 'sunrise')),
      sunset: iso(need(f.daily.sunset[k], 'sunset')),
    });
  }
  const pollen: DetailData['pollen'] = { dates: [], types: [] };
  if (i.show.pollen && i.air) {
    const days = pollenByDay(i.air, i.pollenTypes);
    const today = localDate(now.getTime() / 1000, i.air.utc_offset_seconds);
    const start = Math.max(0, days.dates.indexOf(today));
    pollen.dates = days.dates.slice(start);
    pollen.types = days.types.map((r) => ({ type: r.type, levels: r.levels.slice(start) }));
  }
  let air: DetailData['air'] = null;
  const summary = i.show.air ? airSummary(i.air) : null;
  if (summary && i.air) {
    const c = i.air.current;
    air = {
      ...summary,
      components: {
        pm10: c.pm10 ?? null,
        pm25: c.pm2_5 ?? null,
        no2: c.nitrogen_dioxide ?? null,
        o3: c.ozone ?? null,
        so2: c.sulphur_dioxide ?? null,
      },
    };
  }
  return { place: i.place, hourly, daily, pollen, air };
}
