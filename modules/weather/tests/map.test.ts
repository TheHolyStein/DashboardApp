import { describe, expect, it } from 'vitest';
import { DashError } from '@dash/contract';
import { loadFixture } from '@dash/module-kit/testing';
import { POLLEN_TYPES, type Settings } from '../manifest.js';
import { aqiBand, conditionFromWmo, mapDetail, mapSnapshot, pollenLevel, WMO_TABLE } from '../server/map.js';
import { parseAir, parseForecast, type Air, type Forecast } from '../server/openmeteo.js';
import { HORIZON_DEG, isDayAt, sunAltitudeDeg, sunTimes } from '../server/sun.js';

const dir = import.meta.dirname + '/..';
const rawForecast = (): unknown => loadFixture(dir, 'forecast');
const rawAir = (): unknown => loadFixture(dir, 'air');
// The fixtures were recorded at 2026-11-21T23:45Z; five minutes later is "now" in these tests.
const NOW = new Date('2026-11-21T23:50:00.000Z');
const SHOW: Settings['show'] = { pollen: true, air: true, uv: true };
const ALL = [...POLLEN_TYPES];

const base = (over: Partial<Parameters<typeof mapSnapshot>[0]> = {}): Parameters<typeof mapSnapshot>[0] => ({
  instanceId: 'i1',
  place: 'Berlin',
  units: 'metric',
  forecast: parseForecast(rawForecast()),
  air: parseAir(rawAir()),
  show: SHOW,
  pollenTypes: ALL,
  now: NOW,
  ...over,
});

describe('mapping', () => {
  it('maps forecast.json to exact snapshot values', () => {
    expect(mapSnapshot(base())).toEqual({
      instanceId: 'i1',
      place: 'Berlin',
      units: 'metric',
      now: { tempC: 5.4, feelsC: 1.6, condition: 'rain', windKph: 15.1, humidity: 86 },
      nextPrecip: { at: '2026-11-22T00:00:00.000Z', mm: 0.2 },
      today: { minC: 2.2, maxC: 5.4, uvMax: 1.3, sunrise: '2026-11-22T06:39:58.000Z', sunset: '2026-11-22T15:04:24.000Z' },
      pollen: ALL.map((type) => ({ type, level: 0 })),
      air: { aqi: 19, band: 'good' },
    });
  });

  it('keeps the key order stable so the snapshot pusher can compare JSON', () => {
    expect(Object.keys(mapSnapshot(base()))).toEqual(['instanceId', 'place', 'units', 'now', 'nextPrecip', 'today', 'pollen', 'air']);
  });

  it('each WMO group maps as specified', () => {
    const groups: Array<[string, number[]]> = [
      ['clear', [0, 1]],
      ['cloudy', [2, 3]],
      ['fog', [45, 48]],
      ['drizzle', [51, 52, 53, 54, 55, 56, 57]],
      ['rain', [61, 62, 63, 64, 65, 66, 67, 80, 81, 82]],
      ['snow', [71, 72, 73, 74, 75, 76, 77, 85, 86]],
      ['storm', [95, 96, 97, 98, 99]],
    ];
    for (const [condition, codes] of groups) for (const code of codes) expect(conditionFromWmo(code), `code ${code}`).toBe(condition);
    // Just outside every range falls back to cloudy (an unknown code must not break the tile).
    for (const code of [-1, 4, 44, 46, 49, 50, 58, 60, 68, 70, 78, 79, 83, 84, 87, 94, 100]) {
      expect(conditionFromWmo(code), `code ${code}`).toBe('cloudy');
    }
    expect(WMO_TABLE.length).toBeGreaterThan(0);
  });

  it('pollen thresholds at boundaries (10 → 1, 11 → 2)', () => {
    // Trees: >0, >10, >50, >200, >700.
    const tree = [0, 0.1, 10, 11, 50, 51, 200, 201, 700, 701].map((v) => pollenLevel('birch', v));
    expect(tree).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 5]);
    expect(pollenLevel('alder', 10)).toBe(1);
    expect(pollenLevel('alder', 11)).toBe(2);
    expect(pollenLevel('olive', 701)).toBe(5);
    // Grass, mugwort, ragweed: >0, >5, >20, >50, >150.
    const grass = [0, 0.1, 5, 6, 20, 21, 50, 51, 150, 151].map((v) => pollenLevel('grass', v));
    expect(grass).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4, 5]);
    expect(pollenLevel('mugwort', 5)).toBe(1);
    expect(pollenLevel('ragweed', 6)).toBe(2);
    expect(pollenLevel('birch', -1)).toBe(0);
    expect(pollenLevel('unknown', 999)).toBe(0);
  });

  it('AQI bands at 20, 40, 60, 80', () => {
    const at = [0, 20, 21, 40, 41, 60, 61, 80, 81, 150].map(aqiBand);
    expect(at).toEqual(['good', 'good', 'fair', 'fair', 'moderate', 'moderate', 'poor', 'poor', 'very-poor', 'very-poor']);
  });

  it('nextPrecip null when dry', () => {
    const forecast = parseForecast(rawForecast());
    forecast.hourly.precipitation = forecast.hourly.precipitation.map(() => 0);
    expect(mapSnapshot(base({ forecast }))).toMatchObject({ nextPrecip: null });
  });

  it('nextPrecip is the first hour from now on with at least 0.2 mm, within 24 h', () => {
    const forecast = parseForecast(rawForecast());
    const t0 = forecast.hourly.time[0] as number; // 2026-11-21T23:00Z
    const at = (hour: number): number => hour; // index into hourly
    forecast.hourly.precipitation = forecast.hourly.precipitation.map(() => 0);
    forecast.hourly.precipitation[at(0)] = 5; // the hour containing "now" counts
    expect(mapSnapshot(base({ forecast }))).toMatchObject({ nextPrecip: { at: new Date(t0 * 1000).toISOString(), mm: 5 } });
    forecast.hourly.precipitation[at(0)] = 0.19; // below the limit
    forecast.hourly.precipitation[at(24)] = 3; // 23:00Z the next day starts before now + 24 h (23:50Z): still in range
    expect(mapSnapshot(base({ forecast }))).toMatchObject({ nextPrecip: { mm: 3 } });
    forecast.hourly.precipitation[at(24)] = 0;
    forecast.hourly.precipitation[at(25)] = 3; // 00:00Z on Nov 23: beyond now + 24 h
    expect(mapSnapshot(base({ forecast }))).toMatchObject({ nextPrecip: null });
    // Hours before the current one are history.
    const later = new Date('2026-11-22T02:10:00.000Z');
    forecast.hourly.precipitation[at(25)] = 0;
    forecast.hourly.precipitation[at(1)] = 4; // 00:00Z, already over at 02:10Z
    expect(mapSnapshot(base({ forecast, now: later }))).toMatchObject({ nextPrecip: null });
  });

  it('pollen levels use the highest value of today, only for the chosen types', () => {
    const air = parseAir(rawAir());
    const hours = air.hourly.time.length;
    const today = (type: 'grass_pollen' | 'birch_pollen' | 'ragweed_pollen', v: number): void => {
      air.hourly[type] = Array.from({ length: hours }, (_, i) => (i === 5 ? v : 0));
    };
    today('grass_pollen', 36);
    today('birch_pollen', 11);
    today('ragweed_pollen', 6);
    const snap = mapSnapshot(base({ air, pollenTypes: ['birch', 'grass', 'ragweed'] }));
    expect(snap).toMatchObject({
      pollen: [
        { type: 'birch', level: 2 },
        { type: 'grass', level: 3 },
        { type: 'ragweed', level: 2 },
      ],
    });
  });

  it('pollen is empty without data (outside the model area) and when hidden', () => {
    const air = parseAir(rawAir());
    for (const key of Object.keys(air.hourly)) if (key !== 'time') (air.hourly as Record<string, unknown>)[key] = air.hourly.time.map(() => null);
    expect(mapSnapshot(base({ air }))).toMatchObject({ pollen: [] });
    expect(mapSnapshot(base({ show: { ...SHOW, pollen: false } }))).toMatchObject({ pollen: [] });
  });

  it('hidden air and uv are left out of the snapshot', () => {
    expect(mapSnapshot(base({ show: { pollen: true, air: false, uv: false } }))).toMatchObject({
      air: null,
      today: { uvMax: null },
    });
    expect(mapSnapshot(base({ air: null }))).toMatchObject({ air: null, pollen: [] });
  });

  it('carries the display units, converts nothing', () => {
    expect(mapSnapshot(base({ units: 'imperial' }))).toMatchObject({ units: 'imperial', now: { tempC: 5.4 } });
  });

  it('rejects responses of an unexpected shape with an upstream error', () => {
    for (const bad of ['<html>no</html>', null, {}, { current: {}, hourly: {}, daily: {} }]) {
      expect(() => parseForecast(bad)).toThrow(DashError);
    }
    expect(() => parseAir({ hourly: 3 })).toThrow(DashError);
  });

  it('fails when the forecast does not cover today', () => {
    expect(() => mapSnapshot(base({ now: new Date('2026-12-30T12:00:00.000Z') }))).toThrow(/cover/);
  });

  it('maps the detail: 48 hourly values from this hour, 7 days, pollen per day, air components', () => {
    const forecast: Forecast = parseForecast(rawForecast());
    const air: Air = parseAir(rawAir());
    const d = mapDetail({ place: 'Berlin', forecast, air, show: SHOW, pollenTypes: ['grass'], now: NOW });
    expect(d.place).toBe('Berlin');
    expect(d.hourly).toHaveLength(48);
    expect(d.hourly[0]).toEqual({ t: Date.parse('2026-11-21T23:00:00.000Z'), tempC: 5.4, precipMm: 0, windKph: 15.1 });
    expect(d.hourly[1]).toEqual({ t: Date.parse('2026-11-22T00:00:00.000Z'), tempC: 5.3, precipMm: 0.2, windKph: 15.1 });
    expect(d.daily).toHaveLength(7);
    expect(d.daily[0]).toEqual({
      date: '2026-11-22',
      condition: 'rain',
      minC: 2.2,
      maxC: 5.4,
      precipMm: 1,
      uvMax: 1.3,
      sunrise: '2026-11-22T06:39:58.000Z',
      sunset: '2026-11-22T15:04:24.000Z',
    });
    expect(d.daily[1]).toMatchObject({ date: '2026-11-23', condition: 'snow', precipMm: 0.19 });
    expect(d.pollen).toEqual({ dates: ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25'], types: [{ type: 'grass', levels: [0, 0, 0, 0] }] });
    expect(d.air).toEqual({ aqi: 19, band: 'good', components: { pm10: 6.4, pm25: 4.5, no2: 9.5, o3: 48, so2: 0.8 } });
    const hidden = mapDetail({ place: 'x', forecast, air, show: { pollen: false, air: false, uv: false }, pollenTypes: ALL, now: NOW });
    expect(hidden.pollen).toEqual({ dates: [], types: [] });
    expect(hidden.air).toBeNull();
    expect(hidden.daily[0]?.uvMax).toBeNull();
  });
});

describe('sun position', () => {
  const minutes = (a: Date, iso: string): number => Math.abs(a.getTime() - Date.parse(iso)) / 60_000;

  it('altitude at solar noon follows 90 - lat + declination', () => {
    // Berlin, summer solstice: 90 - 52.52 + 23.44 = 60.92 degrees near 11:06 UTC.
    expect(sunAltitudeDeg(52.52, 13.405, new Date('2026-06-21T11:06:00.000Z'))).toBeCloseTo(60.9, 0);
    // Equator at an equinox noon (lon 0): the sun is near the zenith.
    expect(sunAltitudeDeg(0, 0, new Date('2026-03-20T12:00:00.000Z'))).toBeGreaterThan(87);
    // Below the horizon at local midnight.
    expect(sunAltitudeDeg(52.52, 13.405, new Date('2026-06-21T22:00:00.000Z'))).toBeLessThan(-10);
  });

  it('sunrise and sunset match published values to within three minutes', () => {
    // Berlin 2026-06-21: sunrise 04:43 CEST, sunset 21:33 CEST.
    const berlin = sunTimes(52.52, 13.405, new Date('2026-06-21T12:00:00.000Z'));
    expect(minutes(berlin.sunrise, '2026-06-21T02:43:00.000Z')).toBeLessThan(3);
    expect(minutes(berlin.sunset, '2026-06-21T19:33:00.000Z')).toBeLessThan(3);
    // Sydney 2026-12-21: sunrise 05:41 AEDT, sunset 20:05 AEDT; the solar day is the local one, not the UTC one.
    const sydney = sunTimes(-33.87, 151.21, new Date('2026-12-20T20:00:00.000Z'));
    expect(minutes(sydney.sunrise, '2026-12-20T18:41:00.000Z')).toBeLessThan(3);
    expect(minutes(sydney.sunset, '2026-12-21T09:05:00.000Z')).toBeLessThan(3);
    expect(berlin.polar).toBeNull();
  });

  it('polar day and night have no sunrise', () => {
    expect(sunTimes(78.22, 15.65, new Date('2026-06-21T12:00:00.000Z')).polar).toBe('day');
    expect(sunTimes(78.22, 15.65, new Date('2026-12-21T12:00:00.000Z')).polar).toBe('night');
  });

  it('isDay flips at the computed sunrise', () => {
    const { sunrise } = sunTimes(52.52, 13.405, new Date('2026-06-21T12:00:00.000Z'));
    expect(isDayAt(52.52, 13.405, new Date(sunrise.getTime() - 120_000))).toBe(false);
    expect(isDayAt(52.52, 13.405, new Date(sunrise.getTime() + 120_000))).toBe(true);
    expect(HORIZON_DEG).toBeLessThan(0);
  });
});
