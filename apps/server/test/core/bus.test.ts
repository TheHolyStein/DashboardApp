/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';
import type { ModuleManifest } from '@dash/contract';
import { createBus, wireModuleSubscriptions } from '../../src/core/bus.ts';
import type { LoadedModule } from '../../src/core/modules/deps.ts';
import { manifestFor, serverFor, silentLogger } from './module-env.ts';

const sun = { sunrise: '06:00', sunset: '18:00', isDay: true };
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function setup(manifests: ModuleManifest[]) {
  const logger = { ...silentLogger, warn: vi.fn(), error: vi.fn() };
  const bus = createBus({ manifests: (id) => manifests.find((m) => m.id === id), logger });
  return { bus, logger };
}

describe('event bus', () => {
  it('invalid payload is dropped and logged', async () => {
    const { bus, logger } = setup([manifestFor('timemod', { publishes: ['time.sun'] })]);
    const fn = vi.fn();
    bus.subscribe('core', 'time.sun', fn);
    bus.publish('timemod', 'time.sun', { sunrise: 1, secret: 'topsecret' });
    await flush();
    expect(fn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('timemod');
    expect(logged).toContain('time.sun');
    expect(logged).not.toContain('topsecret');
  });

  it('undeclared event name is dropped', async () => {
    const { bus, logger } = setup([manifestFor('timemod', { publishes: [] })]);
    const fn = vi.fn();
    bus.subscribe('core', 'time.sun', fn);
    bus.publish('timemod', 'time.sun', sun);
    bus.publish('ghost', 'time.sun', sun);
    await flush();
    expect(fn).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('throwing subscriber does not stop other subscribers', async () => {
    const { bus, logger } = setup([]);
    const seen: unknown[] = [];
    bus.subscribe('core', 'time.sun', () => {
      throw new Error('boom');
    });
    bus.subscribe('core', 'time.sun', async () => {
      throw new Error('async boom');
    });
    bus.subscribe('core', 'time.sun', (p) => void seen.push(p));
    expect(() => bus.publish('core', 'time.sun', sun)).not.toThrow();
    expect(seen).toEqual([]); // asynchronous delivery
    await flush();
    expect(seen).toEqual([sun]);
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('notification.created from a module is dropped', async () => {
    const { bus } = setup([manifestFor('spam', { publishes: ['notification.created'] })]);
    const fn = vi.fn();
    bus.subscribe('core', 'notification.created', fn);
    const n = { id: 'n1', userId: 'u', moduleId: 'spam', level: 'info', title: 't', createdAt: 'x' };
    bus.publish('spam', 'notification.created', n);
    bus.publish('core', 'notification.created', n);
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a module can only subscribe to names in its manifest.subscribes', () => {
    const { bus } = setup([manifestFor('sub', { subscribes: ['time.sun'] })]);
    expect(() => bus.subscribe('sub', 'time.sun', () => {})).not.toThrow();
    expect(() => bus.subscribe('sub', 'moon.updated', () => {})).toThrow(/subscribes/);
  });

  it('wireModuleSubscriptions delivers to the module handler with its host', async () => {
    const calls: unknown[] = [];
    const server = serverFor('sub', undefined, {
      manifest: { subscribes: ['time.sun'] },
      on: { 'time.sun': async (p, host) => void calls.push([p, host]) },
    });
    const host = { marker: true } as unknown as LoadedModule['host'];
    const { bus } = setup([server.manifest]);
    wireModuleSubscriptions(bus, { id: 'sub', server, host, enabled: true });
    bus.publish('core', 'time.sun', sun);
    await flush();
    expect(calls).toEqual([[sun, host]]);
  });
});
