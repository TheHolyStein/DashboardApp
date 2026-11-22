import { z } from 'zod';
import { DashError, type EventPayload, type HostServices, type ModuleInstance } from '@dash/contract';
import { abortable, createSnapshotPusher, defineServer, type SnapshotPusher } from '@dash/module-kit';
import manifest, { config as configSchema, settings as settingsSchema, type Config, type DetailData, type Place, type Settings } from '../manifest.js';
import { mapDetail, mapSnapshot, weatherEvent } from './map.js';
import { fetchAir, fetchForecast, fetchGeocode, type Air, type GeoPlace } from './openmeteo.js';
import { isDayAt, sunTimes } from './sun.js';

const MAX_REMEMBERED_AIR = 50;

const GeocodeQuery = z.object({
  // User input. It only ever reaches the upstream URL through URLSearchParams (see openmeteo.ts).
  q: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[^\p{Cc}]+$/u, 'no control characters'),
});

/** Two places closer than the ~1 km the requests are rounded to are the same place. */
const samePlace = (a: Place, b: Place): boolean =>
  Math.round(a.lat * 100) === Math.round(b.lat * 100) && Math.round(a.lon * 100) === Math.round(b.lon * 100);
const spotKey = (p: Place): string => `${Math.round(p.lat * 100)},${Math.round(p.lon * 100)}`;

interface State {
  pusher: SnapshotPusher;
  /** The last `time.sun` this boot published: what it said and for where. Nothing yet = publish at the first run. */
  sun: { isDay: boolean; spot: string } | undefined;
  /** JSON of the last `weather.updated` payload, so an unchanged forecast does not publish again. */
  lastEvent: string | undefined;
  /** The last good air answer per spot, so a failing air API does not take the forecast down with it. */
  air: Map<string, Air>;
}

interface Resolved {
  config: Config;
  settings: Settings;
  place: Place | null;
  isHome: boolean;
}

function createServer() {
  // Created in `setup(host)`, which the loader runs once before any job, route or handler.
  let state: State | undefined;
  const need = (): State => {
    if (!state) throw new Error('weather: setup has not run');
    return state;
  };

  const readConfig = async (host: HostServices, signal: AbortSignal): Promise<Config> => {
    const raw = await abortable(signal, host.config<unknown>());
    const parsed = configSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : configSchema.parse({});
  };

  const resolve = async (host: HostServices, signal: AbortSignal, instance: ModuleInstance): Promise<Resolved> => {
    const config = await readConfig(host, signal);
    const parsed = settingsSchema.safeParse(instance.settings ?? {});
    const settings = parsed.success ? parsed.data : settingsSchema.parse({});
    const place = settings.location ?? config.home ?? null;
    const isHome = place !== null && (settings.location === null || (config.home !== undefined && samePlace(place, config.home)));
    return { config, settings, place, isHome };
  };

  /** The air model is a bonus: when only it fails, keep what was last known for the spot instead of failing the forecast. */
  const loadAir = async (host: HostServices, signal: AbortSignal, place: Place): Promise<Air | null> => {
    const s = need();
    try {
      const air = await fetchAir(host, signal, place.lat, place.lon);
      if (s.air.size >= MAX_REMEMBERED_AIR) s.air.clear();
      s.air.set(spotKey(place), air);
      return air;
    } catch (err) {
      if (signal.aborted) throw err;
      host.log.warn('weather: air quality unavailable', { err: String(err) });
      return s.air.get(spotKey(place)) ?? null;
    }
  };

  return defineServer({
    manifest,

    setup(host) {
      state = { pusher: createSnapshotPusher(host), sun: undefined, lastEvent: undefined, air: new Map() };
    },

    // No per-instance data is stored, so there is nothing to reconcile in `setup`; just let go of the pusher entry.
    onInstanceChange(kind, instance) {
      if (kind === 'removed') need().pusher.forget(instance.id);
      return Promise.resolve();
    },

    jobs: {
      forecast: async ({ host, instance, signal }) => {
        if (!instance) return;
        const s = need();
        const { config, settings, place, isHome } = await resolve(host, signal, instance);
        if (!place) {
          s.pusher.push(instance.id, { needsSetup: true });
          return;
        }
        const wantAir = settings.show.pollen || settings.show.air || isHome;
        const [forecast, air] = await Promise.all([
          fetchForecast(host, signal, place.lat, place.lon),
          wantAir ? loadAir(host, signal, place) : Promise.resolve(null),
        ]);
        const now = host.now();
        const input = { place: place.name, units: config.units, forecast, air, show: settings.show, pollenTypes: settings.pollenTypes, now };
        s.pusher.push(instance.id, mapSnapshot(input));

        if (isHome) {
          const payload = weatherEvent(input);
          const json = JSON.stringify(payload);
          if (json !== s.lastEvent) {
            host.bus.publish('weather.updated', payload);
            s.lastEvent = json;
          }
        }
      },

      // Local arithmetic only: no network. Publishes at the first run after startup, when day turns to night or back,
      // and when the admin moves the home location.
      sun: async ({ host, signal }) => {
        const s = need();
        const { home } = await readConfig(host, signal);
        if (!home) return;
        const now = host.now();
        const isDay = isDayAt(home.lat, home.lon, now);
        const spot = spotKey(home);
        if (s.sun && s.sun.isDay === isDay && s.sun.spot === spot) return;
        const { sunrise, sunset } = sunTimes(home.lat, home.lon, now);
        const payload: EventPayload<'time.sun'> = { sunrise: sunrise.toISOString(), sunset: sunset.toISOString(), isDay };
        host.bus.publish('time.sun', payload);
        s.sun = { isDay, spot };
      },
    },

    routes(r, host) {
      r.get('/geocode', { level: 'view', query: GeocodeQuery }, (req): Promise<GeoPlace[]> =>
        fetchGeocode(host, new AbortController().signal, req.query.q),
      );

      // Instance-scoped: the shell sends `x-dash-instance`; the server answers 404 unless the caller may see that tile's page.
      r.get('/detail', { level: 'view', instance: 'required' }, async (req): Promise<DetailData> => {
        const signal = new AbortController().signal;
        const instance = req.instance;
        if (!instance) throw new DashError('not_found', 'Not found');
        const { settings, place } = await resolve(host, signal, instance);
        if (!place) throw new DashError('not_found', 'weather is not set up');
        const [forecast, air] = await Promise.all([
          fetchForecast(host, signal, place.lat, place.lon),
          settings.show.pollen || settings.show.air ? loadAir(host, signal, place) : Promise.resolve(null),
        ]);
        return mapDetail({ place: place.name, forecast, air, show: settings.show, pollenTypes: settings.pollenTypes, now: host.now() });
      });
    },
  });
}

export default createServer();
