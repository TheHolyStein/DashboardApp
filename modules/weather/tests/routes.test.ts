import { describe, expect, it } from 'vitest';
import { createMockRouter } from '@dash/module-kit/testing';
import server from '../server/index.js';
import { instance, PARIS, setup } from './helpers.js';

async function routes(opts: Parameters<typeof setup>[0] = {}) {
  const { host } = await setup(opts);
  return { host, router: createMockRouter(server, host) };
}

describe('GET /geocode', () => {
  it('returns up to five places with a region line', async () => {
    const { host, router } = await routes();
    const res = await router.call('GET', '/geocode', { level: 'view', query: { q: ' Berlin ' } });
    expect(res.status).toBe(200);
    const list = res.body as Array<{ name: string; lat: number; lon: number; detail: string }>;
    expect(list).toHaveLength(5);
    expect(list[0]).toEqual({ name: 'Berlin', lat: 52.52437, lon: 13.41053, detail: 'State of Berlin, Germany' });
    expect(list[1]?.detail).toBe('New Hampshire, United States');
    expect(host.requests[0]?.url).toBe('https://geocoding-api.open-meteo.com/v1/search?name=Berlin&count=5&language=en&format=json');
  });

  it('the query text can only ever be one URL parameter value', async () => {
    const { host, router } = await routes();
    await router.call('GET', '/geocode', { level: 'view', query: { q: 'a&count=100#x/../y?z' } });
    const url = new URL(host.requests[0]?.url ?? '');
    expect(url.host).toBe('geocoding-api.open-meteo.com');
    expect(url.pathname).toBe('/v1/search');
    expect(url.searchParams.get('name')).toBe('a&count=100#x/../y?z');
    expect(url.searchParams.getAll('count')).toEqual(['5']);
    expect(url.hash).toBe('');
  });

  it('rejects a missing, too short, too long or control-character query with 422', async () => {
    const { host, router } = await routes();
    for (const q of [undefined, '', ' a ', 'x'.repeat(81), 'ab\ncd', 'ab\u0000']) {
      const res = await router.call('GET', '/geocode', { level: 'view', query: q === undefined ? {} : { q } });
      expect(res.status, JSON.stringify(q)).toBe(422);
    }
    expect(host.requests).toEqual([]);
  });

  it('an upstream failure is a 502; no match is an empty list', async () => {
    const down = await routes({ respond: false });
    down.host.respond('geocoding-api', { status: 500, data: {} });
    expect((await down.router.call('GET', '/geocode', { level: 'view', query: { q: 'Berlin' } })).status).toBe(502);
    const empty = await routes({ respond: false });
    empty.host.respond('geocoding-api', { data: { generationtime_ms: 0.4 } });
    expect(await empty.router.call('GET', '/geocode', { level: 'view', query: { q: 'Nowhere' } })).toEqual({ status: 200, body: [] });
  });
});

describe('GET /detail', () => {
  it('returns hourly, daily, pollen and air data for the instance', async () => {
    const { router } = await routes({ instances: [instance('i1')] });
    const res = await router.call('GET', '/detail', { level: 'view', query: { instanceId: 'i1' } });
    expect(res.status).toBe(200);
    const body = res.body as { place: string; hourly: unknown[]; daily: unknown[]; pollen: { dates: string[] }; air: { aqi: number } };
    expect(body.place).toBe('Berlin');
    expect(body.hourly).toHaveLength(48);
    expect(body.daily).toHaveLength(7);
    expect(body.pollen.dates).toHaveLength(4);
    expect(body.air.aqi).toBe(19);
  });

  it('uses the location of the instance and leaves hidden parts out', async () => {
    const paris = instance('i2', { location: PARIS, show: { pollen: false, air: false, uv: false } });
    const { host, router } = await routes({ instances: [paris] });
    const res = await router.call('GET', '/detail', { level: 'view', query: { instanceId: 'i2' } });
    expect(res.body).toMatchObject({ place: 'Paris', pollen: { dates: [], types: [] }, air: null });
    expect(host.requests.every((r) => r.opts?.ttlSec === 1500)).toBe(true);
    expect(host.requests.some((r) => r.url.includes('air-quality'))).toBe(false);
  });

  it('404 for an unknown instance or one that is not set up; 422 without an id', async () => {
    const { router } = await routes({ config: {}, instances: [instance('i1')] });
    expect((await router.call('GET', '/detail', { level: 'view', query: { instanceId: 'nope' } })).status).toBe(404);
    expect((await router.call('GET', '/detail', { level: 'view', query: { instanceId: 'i1' } })).status).toBe(404);
    expect((await router.call('GET', '/detail', { level: 'view', query: {} })).status).toBe(422);
  });

  it('502 when the forecast API is down', async () => {
    const { host, router } = await routes({ instances: [instance('i1')], respond: false });
    host.respond('api.open-meteo.com', new Error('ECONNRESET'));
    expect((await router.call('GET', '/detail', { level: 'view', query: { instanceId: 'i1' } })).status).toBe(502);
  });
});
