# Weather (`weather`)

Current weather, a 48 h chart, a 7-day outlook, the next rain, pollen per type and the European air quality index for a
place, from [Open-Meteo](https://open-meteo.com/) (free, no key). Shared scope, several instances per dashboard, view
level only (nothing here changes stored data).

- `manifest.ts`: id, tile sizes, jobs, events, outbound hosts, the settings/config schemas and the snapshot/detail types.
- `server/openmeteo.ts`: request URLs, response schemas, `host.http` calls. `server/map.ts`: WMO table, pollen and AQI
  thresholds, response to snapshot/detail mapping. `server/sun.ts`: NOAA solar position. `server/index.ts`: jobs, routes.
- `client/`: `Tile.svelte`, `Detail.svelte` (charts via `@dash/ui` `Chart`), `Settings.svelte` (place search),
  `ConditionIcon.svelte`, `PollenBar.svelte`, `format.ts` (unit conversion and `Intl` formatting).
- `fixtures/`: `forecast.json`, `air.json`, `geocode.json` are real Open-Meteo responses for Berlin recorded on
  2026-11-21 with the parameter lists below (`air.json` has no pollen: it is off season, all values are 0); `tile.json`
  and `detail.json` feed the client tests.

## Configuration

Module config (admin): `home: { name, lat, lon }` and `units: 'metric' | 'imperial'` (default metric).
Instance settings: `location` (`null` = home), `show: { pollen, air, uv }` (all on), `pollenTypes` (default all six).
Without a home and without an instance location the tile shows "Open settings to set up" and no request is made.

All values are stored and pushed in metric; `units` only decides how clients display them (it travels in the snapshot).

## Jobs and events

- `forecast` (1800 s, when viewed, per instance): fetches forecast and air quality for the instance's place, pushes its
  snapshot. For the home place (location `null`, or the same spot as home) it publishes `weather.updated` when the payload
  changed; the payload covers all pollen types and ignores the tile's `show` flags. A failing forecast keeps the last
  snapshot (`DashError('upstream')`); a failing air API only drops pollen and air from that snapshot.
- `sun` (900 s, always, module): computes sunrise, sunset and the sun's altitude locally (NOAA equations, no network) for
  the home location and publishes `time.sun` at the first run after startup, when `isDay` flips (sun centre above -0.833
  degrees), and when the home location moves. In polar day or night sunrise and sunset in the event are solar noon.

## Routes (view level)

- `GET /geocode?q=<2-80 characters>`: up to five places `{ name, lat, lon, detail }`; `q` is only ever one value
  built with `URLSearchParams`.
- `GET /detail` (instance-scoped: `x-dash-instance`, 404 when the caller cannot see the tile's page): hourly 48 h (temperature, precipitation, wind), daily 7 days, pollen level per type and
  day, AQI with components. The location comes from the instance's stored settings. The snapshot keeps `units` (the admin's choice) because the client has no admin config.

## Upstream requests

Every request goes through `host.http` with `ttlSec: 1500` (geocoding: 3600), so instances on the same spot (coordinates
rounded to 0.01 degrees) share one upstream call; nothing instance-specific is in the URLs.

| Host | Path | Parameters |
|---|---|---|
| `api.open-meteo.com` | `/v1/forecast` | `latitude`, `longitude`, `current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m`, `hourly=temperature_2m,precipitation,wind_speed_10m`, `daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,uv_index_max,sunrise,sunset`, `forecast_days=7`, `timezone=auto`, `timeformat=unixtime`, `wind_speed_unit=kmh`, `temperature_unit=celsius`, `precipitation_unit=mm` |
| `air-quality-api.open-meteo.com` | `/v1/air-quality` | `latitude`, `longitude`, `current=european_aqi,pm10,pm2_5,nitrogen_dioxide,ozone,sulphur_dioxide`, `hourly=alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen`, `forecast_days=4`, `timezone=auto`, `timeformat=unixtime` |
| `geocoding-api.open-meteo.com` | `/v1/search` | `name`, `count=5`, `language=en`, `format=json` |

## Rules

- WMO codes: `0,1` clear, `2,3` cloudy, `45,48` fog, `51-57` drizzle, `61-67,80-82` rain, `71-77,85,86` snow, `95-99`
  storm; an unknown code reads as cloudy (`WMO_TABLE` in `server/map.ts`).
- Pollen (grains/m3), level 1 to 5 when the value is above: trees (alder, birch, olive) 0, 10, 50, 200, 700; grass,
  mugwort, ragweed 0, 5, 20, 50, 150. The tile shows the worst type, using the highest hourly value of today.
- European AQI bands: up to 20 good, 40 fair, 60 moderate, 80 poor, above very poor.
- `nextPrecip`: the first hour from the current hour on, within 24 h of now, with at least 0.2 mm.

## Limits

Pollen exists only for Europe; elsewhere the pollen part is empty. The forecast and air data are up to about 25 minutes
old (cache) plus the job interval. Shared pages show the owner's location name and weather to every viewer.

Rules: import only `@dash/contract`, `@dash/module-kit`, `@dash/ui` and your own files; every visible string goes
through `t(key, fallback)`; time comes from `host.now()`. Tests: `pnpm --filter @dash/module-weather test`.
