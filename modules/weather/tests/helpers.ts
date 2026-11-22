import type { ModuleInstance } from '@dash/contract';
import { createMockHostWithSetup, loadFixture, type MockHost } from '@dash/module-kit/testing';
import { settings as settingsSchema, type Config, type Settings } from '../manifest.js';
import server from '../server/index.js';

export const dir = import.meta.dirname + '/..';
export const BERLIN = { name: 'Berlin', lat: 52.52, lon: 13.41 };
export const PARIS = { name: 'Paris', lat: 48.85, lon: 2.35 };
/** Five minutes after the fixtures were recorded (2026-11-21T23:45Z). */
export const NOW = new Date('2026-11-21T23:50:00.000Z');

export const instance = (id: string, over: Partial<Settings> = {}): ModuleInstance<Settings> => ({
  id,
  ownerId: 'u1',
  pageId: 'p1',
  settings: settingsSchema.parse(over),
});

export function respondOk(host: MockHost): void {
  host.respond('api.open-meteo.com/v1/forecast', { data: loadFixture(dir, 'forecast') });
  host.respond('air-quality-api.open-meteo.com', { data: loadFixture(dir, 'air') });
  host.respond('geocoding-api.open-meteo.com', { data: loadFixture(dir, 'geocode') });
}

export async function setup(opts: { config?: Partial<Config>; instances?: Array<ModuleInstance<Settings>>; now?: Date; respond?: boolean } = {}) {
  const host = await createMockHostWithSetup(server, {
    now: opts.now ?? NOW,
    prepare: (h) => {
      h.setConfig(opts.config ?? { home: BERLIN, units: 'metric' });
      h.setInstances(opts.instances ?? []);
      if (opts.respond !== false) respondOk(h);
    },
  });
  const job = (name: 'forecast' | 'sun', inst: ModuleInstance<Settings> | null = null, signal = new AbortController().signal): Promise<void> => {
    const fn = server.jobs?.[name];
    if (!fn) throw new Error(`no job ${name}`);
    return fn({ host, instance: inst, signal });
  };
  return { host, job };
}
