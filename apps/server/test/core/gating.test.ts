// Modules that are disabled or never set up get no events, requests or instance notifications.
import { describe, expect, it, vi } from 'vitest';
import type { ModuleInstance } from '@dash/contract';
import { createBus, wireModuleSubscriptions } from '../../src/core/bus.ts';
import { notifyInstanceChange } from '../../src/core/instances.ts';
import type { LoadedModule } from '../../src/core/modules/deps.ts';
import { serverFor, silentLogger } from './module-env.ts';

function loaded(over: Partial<LoadedModule>) {
  const handler = vi.fn(async () => {});
  const change = vi.fn(async () => {});
  const server = serverFor('gated', undefined, { onInstanceChange: change, manifest: { subscribes: ['time.sun'] } });
  server.on = { 'time.sun': handler };
  const mod: LoadedModule = { id: 'gated', server, host: {} as LoadedModule['host'], enabled: true, setupRan: true, ...over };
  return { mod, handler, change };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function delivered(mod: LoadedModule, handler: ReturnType<typeof vi.fn>): Promise<number> {
  const bus = createBus({ manifests: () => mod.server.manifest, logger: silentLogger });
  wireModuleSubscriptions(bus, mod);
  bus.publish('core', 'time.sun', { sunrise: 'a', sunset: 'b', isDay: true });
  await flush();
  return handler.mock.calls.length;
}

describe('event and instance-change gating', () => {
  it('delivers to an enabled, set-up module', async () => {
    const { mod, handler } = loaded({});
    expect(await delivered(mod, handler)).toBe(1);
  });

  it.each([
    ['disabled', { enabled: false }],
    ['not set up', { setupRan: false }],
  ])('skips handlers of a %s module', async (_n, over) => {
    const { mod, handler } = loaded(over);
    expect(await delivered(mod, handler)).toBe(0);
  });

  it.each([
    ['disabled', { enabled: false }],
    ['not set up', { setupRan: false }],
  ])('skips onInstanceChange of a %s module', async (_n, over) => {
    const { mod, change } = loaded(over);
    await notifyInstanceChange({ logger: silentLogger }, mod, 'added', {} as ModuleInstance);
    expect(change).not.toHaveBeenCalled();
  });

  it('delivers "removed" to a disabled module that was set up, but not "added" or "updated"', async () => {
    const { mod, change } = loaded({ enabled: false });
    await notifyInstanceChange({ logger: silentLogger }, mod, 'removed', {} as ModuleInstance);
    expect(change).toHaveBeenCalledOnce();
    await notifyInstanceChange({ logger: silentLogger }, mod, 'added', {} as ModuleInstance);
    await notifyInstanceChange({ logger: silentLogger }, mod, 'updated', {} as ModuleInstance);
    expect(change).toHaveBeenCalledOnce();
  });

  it('does not deliver "removed" to a module that never ran setup', async () => {
    const { mod, change } = loaded({ enabled: false, setupRan: false });
    await notifyInstanceChange({ logger: silentLogger }, mod, 'removed', {} as ModuleInstance);
    expect(change).not.toHaveBeenCalled();
  });

  it('runs onInstanceChange for an enabled, set-up module', async () => {
    const { mod, change } = loaded({});
    await notifyInstanceChange({ logger: silentLogger }, mod, 'added', {} as ModuleInstance);
    expect(change).toHaveBeenCalledOnce();
  });
});
