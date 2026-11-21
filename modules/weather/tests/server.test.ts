import { describe, expect, it } from 'vitest';
import { DashError } from '@dash/contract';
import { loadFixture, runServerContractSuite } from '@dash/module-kit/testing';
import server from '../server/index.js';
import { BERLIN, dir, instance, PARIS, respondOk, setup } from './helpers.js';

runServerContractSuite(server, { moduleDir: dir, happyHttp: respondOk });

describe('forecast job', () => {
  it('missing home config → needsSetup snapshot, no request', async () => {
    const a = instance('i1');
    const { host, job } = await setup({ config: {}, instances: [a] });
    await job('forecast', a);
    expect(host.requests).toEqual([]);
    expect(host.pushed).toEqual([{ instanceId: 'i1', data: { needsSetup: true } }]);
    expect(host.published).toEqual([]);
  });

  it('pushes the snapshot of the instance and does not push an unchanged one twice', async () => {
    const a = instance('i1');
    const { host, job } = await setup({ instances: [a] });
    await job('forecast', a);
    await job('forecast', a);
    expect(host.pushed).toHaveLength(1);
    expect(host.pushed[0]).toMatchObject({
      instanceId: 'i1',
      data: { instanceId: 'i1', place: 'Berlin', units: 'metric', now: { tempC: 5.4, condition: 'rain' }, air: { aqi: 19, band: 'good' } },
    });
  });

  it('weather.updated only for home', async () => {
    const home = instance('i1');
    const paris = instance('i2', { location: PARIS });
    const { host, job } = await setup({ instances: [home, paris] });
    await job('forecast', paris);
    expect(host.published).toEqual([]);
    await job('forecast', home);
    expect(host.published).toEqual([
      {
        name: 'weather.updated',
        payload: { condition: 'rain', tempC: 5.4, nextPrecip: { at: '2026-11-22T00:00:00.000Z', mm: 0.2 }, pollenMax: 0, aqi: 19 },
      },
    ]);
    expect(host.pushed.map((p) => p.instanceId)).toEqual(['i2', 'i1']);
  });

  it('an instance placed on the home spot counts as home; an unchanged event is not repeated', async () => {
    const same = instance('i1', { location: { ...BERLIN, name: 'Berlin, Mitte' } });
    const home = instance('i2');
    const { host, job } = await setup({ instances: [same, home] });
    await job('forecast', same);
    await job('forecast', home);
    expect(host.published.filter((p) => p.name === 'weather.updated')).toHaveLength(1);
  });

  it('the home event ignores what a tile chooses to show', async () => {
    const home = instance('i1', { show: { pollen: false, air: false, uv: false } });
    const { host, job } = await setup({ instances: [home] });
    await job('forecast', home);
    expect(host.published[0]?.payload).toMatchObject({ pollenMax: 0, aqi: 19 });
    expect(host.pushed[0]?.data).toMatchObject({ air: null, pollen: [] });
  });

  it('two instances same location → one upstream request', async () => {
    // The mock host has no cache; the real one answers identical requests with ttlSec from one upstream call.
    // So the proof is: both instances ask for identical URLs, every one with ttlSec 1500.
    const a = instance('i1', { location: PARIS });
    const b = instance('i2', { location: { ...PARIS, name: 'Paris, FR' }, show: { pollen: false, air: false, uv: true } });
    const { host, job } = await setup({ instances: [a, b] });
    await job('forecast', a);
    const afterA = host.requests.length;
    await job('forecast', b);
    const forecastUrls = host.requests.filter((r) => r.url.includes('/v1/forecast')).map((r) => r.url);
    expect(forecastUrls).toHaveLength(2);
    expect(new Set(forecastUrls).size).toBe(1);
    expect(afterA).toBe(2); // forecast and air for the first instance
    expect(host.requests.every((r) => r.opts?.ttlSec === 1500)).toBe(true);
    const air = host.requests.filter((r) => r.url.includes('air-quality'));
    expect(air).toHaveLength(1); // the second tile hides pollen and air: it does not even ask
  });

  it('requests carry only URL-encoded parameters for rounded coordinates', async () => {
    const a = instance('i1', { location: { name: 'X', lat: 48.8566, lon: 2.3522 } });
    const { host, job } = await setup({ instances: [a] });
    await job('forecast', a);
    const url = new URL(host.requests[0]?.url ?? '');
    expect(url.origin).toBe('https://api.open-meteo.com');
    expect(url.searchParams.get('latitude')).toBe('48.86');
    expect(url.searchParams.get('longitude')).toBe('2.35');
    expect(url.searchParams.get('timeformat')).toBe('unixtime');
  });

  it('a failing forecast throws an upstream error and keeps the last snapshot', async () => {
    const a = instance('i1');
    const { host, job } = await setup({ instances: [a], respond: false });
    host.respond('api.open-meteo.com', { status: 503, data: { error: true } });
    await expect(job('forecast', a)).rejects.toMatchObject({ code: 'upstream' });
    expect(host.pushed).toEqual([]);
    expect(host.published).toEqual([]);
  });

  it('a failing air API still pushes the forecast (without air)', async () => {
    const a = instance('i1');
    const { host, job } = await setup({ instances: [a], respond: false });
    host.respond('air-quality-api.open-meteo.com', { status: 500, data: {} });
    host.respond('api.open-meteo.com/v1/forecast', { data: loadFixture(dir, 'forecast') });
    await job('forecast', a);
    expect(host.pushed[0]?.data).toMatchObject({ air: null, pollen: [], now: { tempC: 5.4 } });
  });

  it('upstream garbage (not the expected shape) is an upstream error', async () => {
    const a = instance('i1');
    const { host, job } = await setup({ instances: [a], respond: false });
    host.respond(/.*/, { data: { current: 1 } });
    await expect(job('forecast', a)).rejects.toBeInstanceOf(DashError);
  });

  it('the forecast of a removed instance is pushed again when the id comes back', async () => {
    const a = instance('i1');
    const { host, job } = await setup({ instances: [a] });
    await job('forecast', a);
    await server.onInstanceChange?.('removed', a, host);
    await job('forecast', a);
    expect(host.pushed).toHaveLength(2);
  });
});

describe('sun job', () => {
  const noon = new Date('2026-06-21T12:00:00.000Z');
  const midnight = new Date('2026-06-21T22:30:00.000Z');
  const suns = (host: { published: Array<{ name: string; payload: unknown }> }) => host.published.filter((p) => p.name === 'time.sun');

  it('time.sun published on flip, not on every run', async () => {
    const { host, job } = await setup({ now: noon });
    await job('sun');
    expect(suns(host)).toHaveLength(1); // at startup
    const first = suns(host)[0]?.payload as { sunrise: string; sunset: string; isDay: boolean };
    expect(first.isDay).toBe(true);
    // Berlin on 2026-06-21: sunrise about 02:43Z, sunset about 19:33Z.
    expect(Math.abs(Date.parse(first.sunrise) - Date.parse('2026-06-21T02:43:00Z'))).toBeLessThan(3 * 60_000);
    expect(Math.abs(Date.parse(first.sunset) - Date.parse('2026-06-21T19:33:00Z'))).toBeLessThan(3 * 60_000);
    host.advance(15 * 60_000);
    await job('sun');
    host.advance(15 * 60_000);
    await job('sun');
    expect(suns(host)).toHaveLength(1);
    host.setNow(midnight);
    await job('sun');
    expect(suns(host)).toHaveLength(2);
    expect((suns(host)[1]?.payload as { isDay: boolean }).isDay).toBe(false);
    await job('sun');
    expect(suns(host)).toHaveLength(2);
    host.setNow(noon);
    await job('sun');
    expect(suns(host)).toHaveLength(3);
  });

  it('uses no network and publishes nothing without a home location', async () => {
    const without = await setup({ config: {}, now: noon });
    await without.job('sun');
    expect(without.host.published).toEqual([]);
    const withHome = await setup({ now: noon });
    await withHome.job('sun');
    expect(withHome.host.requests).toEqual([]);
  });

  it('publishes again when the admin moves the home location', async () => {
    const { host, job } = await setup({ now: noon });
    await job('sun');
    host.setConfig({ home: { name: 'Sydney', lat: -33.87, lon: 151.21 }, units: 'metric' });
    await job('sun'); // 12:00Z is 23:00 in Sydney: night there
    expect(suns(host)).toHaveLength(2);
    expect((suns(host)[1]?.payload as { isDay: boolean }).isDay).toBe(false);
  });
});
