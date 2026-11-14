import type { ModuleClient } from '@dash/contract';
import type { HostEntry, HostRegistry } from '../../src/lib/host.js';
import Detail from './Detail.svelte';
import GoodTile from './GoodTile.svelte';
import ThrowTile from './ThrowTile.svelte';

const tile = { default: { w: 3, h: 2 }, min: { w: 2, h: 1 }, max: { w: 4, h: 3 } };

export function client(id: string, Tile: ModuleClient['Tile'], extra: Partial<ModuleClient> = {}): ModuleClient {
  return {
    manifest: { id, name: id, tile } as ModuleClient['manifest'],
    Tile,
    Detail,
    ...extra,
  };
}

/**
 * Registry of fake modules: `good` renders, `boom` throws while `control.throwTile` is set.
 * `loads` counts load() calls per module; `failLoad` makes the next load() of that module reject.
 */
export function fakeRegistry(): { modules: HostRegistry; loads: Record<string, number>; failLoad: Set<string> } {
  const loads: Record<string, number> = {};
  const failLoad = new Set<string>();
  const entry = (id: string, name: string, c: ModuleClient): HostEntry => ({
    manifest: { id, name, icon: 'clock', tile },
    load: () => {
      loads[id] = (loads[id] ?? 0) + 1;
      if (failLoad.delete(id)) return Promise.reject(new Error('chunk failed'));
      return Promise.resolve({ default: c });
    },
  });
  const modules: HostRegistry = {
    good: entry('good', 'Good', client('good', GoodTile as never, { icons: { clock: '<svg data-testid="mod-icon"></svg>' } })),
    boom: entry('boom', 'Boom', client('boom', ThrowTile as never)),
  };
  return { modules, loads, failLoad };
}
