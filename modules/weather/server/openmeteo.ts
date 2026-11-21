import { z } from 'zod';
import { DashError, type HostServices } from '@dash/contract';
import { abortable } from '@dash/module-kit';

/** One cache lifetime for every Open-Meteo request, so instances sharing a location share one upstream call. */
export const TTL_SEC = 1500;
const TIMEOUT_MS = 15_000;

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

// The exact parameter lists this module requests; see the README ("Upstream requests").
export const FORECAST_CURRENT = 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m';
export const FORECAST_HOURLY = 'temperature_2m,precipitation,wind_speed_10m';
export const FORECAST_DAILY =
  'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,uv_index_max,sunrise,sunset';
export const AIR_CURRENT = 'european_aqi,pm10,pm2_5,nitrogen_dioxide,ozone,sulphur_dioxide';
export const AIR_HOURLY = 'alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen';

/** ~1 km: close enough for weather, and instances on the same spot produce the same URL (so one cache entry). */
const coord = (v: number): string => String(Math.round(v * 100) / 100);

export function forecastUrl(lat: number, lon: number): string {
  const q = new URLSearchParams({
    latitude: coord(lat),
    longitude: coord(lon),
    current: FORECAST_CURRENT,
    hourly: FORECAST_HOURLY,
    daily: FORECAST_DAILY,
    forecast_days: '7',
    timezone: 'auto',
    timeformat: 'unixtime',
    wind_speed_unit: 'kmh',
    temperature_unit: 'celsius',
    precipitation_unit: 'mm',
  });
  return `${FORECAST_URL}?${q.toString()}`;
}

export function airUrl(lat: number, lon: number): string {
  const q = new URLSearchParams({
    latitude: coord(lat),
    longitude: coord(lon),
    current: AIR_CURRENT,
    hourly: AIR_HOURLY,
    forecast_days: '4',
    timezone: 'auto',
    timeformat: 'unixtime',
  });
  return `${AIR_URL}?${q.toString()}`;
}

/** `name` is user input: it only ever reaches the URL through URLSearchParams. */
export function geocodeUrl(name: string): string {
  const q = new URLSearchParams({ name, count: '5', language: 'en', format: 'json' });
  return `${GEOCODE_URL}?${q.toString()}`;
}

const num = z.number();
const series = z.array(z.number().nullable());
const optSeries = series.optional();

const forecastSchema = z.object({
  utc_offset_seconds: num,
  current: z.object({
    time: num,
    temperature_2m: num,
    apparent_temperature: num,
    relative_humidity_2m: num,
    weather_code: num,
    wind_speed_10m: num,
  }),
  hourly: z.object({
    time: z.array(num),
    temperature_2m: series,
    precipitation: series,
    wind_speed_10m: series,
  }),
  daily: z.object({
    time: z.array(num),
    weather_code: series,
    temperature_2m_max: series,
    temperature_2m_min: series,
    precipitation_sum: series,
    uv_index_max: series,
    sunrise: series,
    sunset: series,
  }),
});
export type Forecast = z.infer<typeof forecastSchema>;

const airSchema = z.object({
  utc_offset_seconds: num,
  current: z.object({
    european_aqi: z.number().nullable().optional(),
    pm10: z.number().nullable().optional(),
    pm2_5: z.number().nullable().optional(),
    nitrogen_dioxide: z.number().nullable().optional(),
    ozone: z.number().nullable().optional(),
    sulphur_dioxide: z.number().nullable().optional(),
  }),
  hourly: z.object({
    time: z.array(num),
    alder_pollen: optSeries,
    birch_pollen: optSeries,
    grass_pollen: optSeries,
    mugwort_pollen: optSeries,
    olive_pollen: optSeries,
    ragweed_pollen: optSeries,
  }),
});
export type Air = z.infer<typeof airSchema>;

const geocodeSchema = z.object({
  results: z
    .array(
      z.object({
        name: z.string(),
        latitude: num,
        longitude: num,
        country: z.string().optional(),
        admin1: z.string().optional(),
      }),
    )
    .optional(),
});

function parse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const out = schema.safeParse(data);
  if (!out.success) throw new DashError('upstream', `unexpected ${what} response`);
  return out.data;
}
export const parseForecast = (data: unknown): Forecast => parse(forecastSchema, data, 'forecast');
export const parseAir = (data: unknown): Air => parse(airSchema, data, 'air quality');

export interface GeoPlace {
  name: string;
  lat: number;
  lon: number;
  /** "Region, Country" for telling places of one name apart. */
  detail: string;
}

/** Every outbound request goes through `host.http`; anything that is not a clean 2xx JSON answer is an upstream error. */
async function get(host: HostServices, signal: AbortSignal, url: string, ttlSec: number): Promise<unknown> {
  try {
    const res = await abortable(signal, host.http.fetch<unknown>(url, { ttlSec, timeoutMs: TIMEOUT_MS }));
    if (res.status < 200 || res.status >= 300) throw new DashError('upstream', `Open-Meteo answered ${res.status}`);
    return res.data;
  } catch (err) {
    if (err instanceof DashError) throw err;
    throw new DashError('upstream', 'Open-Meteo request failed');
  }
}

export async function fetchForecast(host: HostServices, signal: AbortSignal, lat: number, lon: number): Promise<Forecast> {
  return parseForecast(await get(host, signal, forecastUrl(lat, lon), TTL_SEC));
}

export async function fetchAir(host: HostServices, signal: AbortSignal, lat: number, lon: number): Promise<Air> {
  return parseAir(await get(host, signal, airUrl(lat, lon), TTL_SEC));
}

export async function fetchGeocode(host: HostServices, signal: AbortSignal, name: string): Promise<GeoPlace[]> {
  const body = parse(geocodeSchema, await get(host, signal, geocodeUrl(name), 3600), 'geocoding');
  return (body.results ?? []).slice(0, 5).map((r) => ({
    name: r.name,
    lat: r.latitude,
    lon: r.longitude,
    detail: [r.admin1, r.country].filter((p): p is string => !!p && p !== r.name).join(', '),
  }));
}
