import { z } from 'zod';
import { defineManifest } from '@dash/module-kit';

export const POLLEN_TYPES = ['alder', 'birch', 'grass', 'mugwort', 'olive', 'ragweed'] as const;
export type PollenType = (typeof POLLEN_TYPES)[number];

const place = z.object({
  name: z.string().trim().min(1).max(80),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type Place = z.infer<typeof place>;

/** Per-instance settings. `location: null` means "use the home location from the module config". */
export const settings = z.object({
  location: place.nullable().default(null),
  show: z
    .object({
      pollen: z.boolean().default(true),
      air: z.boolean().default(true),
      uv: z.boolean().default(true),
    })
    .default({ pollen: true, air: true, uv: true }),
  pollenTypes: z.array(z.enum(POLLEN_TYPES)).max(POLLEN_TYPES.length).default([...POLLEN_TYPES]),
});
export type Settings = z.infer<typeof settings>;

/** Module-wide (admin) config. Data is stored in metric; `units` only decides how the clients display it. */
export const config = z.object({
  home: place.optional().meta({ label: 'Home location' }),
  units: z.enum(['metric', 'imperial']).default('metric').meta({ label: 'Units' }),
});
export type Config = z.infer<typeof config>;

export type Condition = 'clear' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'snow' | 'storm';
export type PollenLevel = 0 | 1 | 2 | 3 | 4 | 5;
export type AqiBand = 'good' | 'fair' | 'moderate' | 'poor' | 'very-poor';

/** The forecast part of a snapshot. All values metric; times are UTC ISO-8601. */
export type Forecast = {
  /** Lets the detail pane ask `GET /detail?instanceId=` (the shell passes no instance id to the pane). */
  instanceId: string;
  place: string;
  /** How clients display the (metric) numbers: the admin's choice at the time of the last fetch. */
  units: 'metric' | 'imperial';
  now: { tempC: number; feelsC: number; condition: Condition; windKph: number; humidity: number };
  nextPrecip: { at: string; mm: number } | null;
  today: { minC: number; maxC: number; uvMax: number | null; sunrise: string; sunset: string };
  pollen: Array<{ type: string; level: PollenLevel }>;
  air: { aqi: number; band: AqiBand } | null;
};
export type Snapshot = { needsSetup: true } | ({ needsSetup?: undefined } & Forecast);

/** Body of `GET /detail`. Hourly and daily series are metric; `t` is epoch ms, `date` is the location's calendar day. */
export type DetailData = {
  place: string;
  hourly: Array<{ t: number; tempC: number; precipMm: number; windKph: number }>;
  daily: Array<{
    date: string;
    condition: Condition;
    minC: number;
    maxC: number;
    precipMm: number;
    uvMax: number | null;
    sunrise: string;
    sunset: string;
  }>;
  /** Per type, the day's highest hourly level for each date in `dates`; null where the model has no data. */
  pollen: { dates: string[]; types: Array<{ type: string; levels: Array<PollenLevel | null> }> };
  air: {
    aqi: number;
    band: AqiBand;
    components: { pm10: number | null; pm25: number | null; no2: number | null; o3: number | null; so2: number | null };
  } | null;
};

export default defineManifest({
  id: 'weather',
  name: 'Weather',
  description: 'Forecast, rain, pollen and air quality for your location, from Open-Meteo.',
  version: '0.1.0',
  icon: 'weather',
  scope: 'shared',
  multiInstance: true,
  tile: { default: { w: 3, h: 2 }, min: { w: 2, h: 1 }, max: { w: 6, h: 4 }, staleAfterSec: 5400 },
  settings,
  config,
  levels: ['view'],
  jobs: [
    { name: 'forecast', intervalSec: 1800, mode: 'whenViewed', per: 'instance' },
    { name: 'sun', intervalSec: 900, mode: 'always', per: 'module' },
  ],
  publishes: ['weather.updated', 'time.sun'],
  subscribes: [],
  outbound: [
    { kind: 'host', host: 'api.open-meteo.com' },
    { kind: 'host', host: 'air-quality-api.open-meteo.com' },
    { kind: 'host', host: 'geocoding-api.open-meteo.com' },
  ],
});
