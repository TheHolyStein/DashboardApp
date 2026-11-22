import type { z } from 'zod';
import type { InstanceDto, PageDto } from '@dash/contract';
import type { GridItem, GridLike } from '../../src/lib/grid.js';
import type { HostRegistry } from '../../src/lib/host.js';
import GoodTile from '../fixtures/GoodTile.svelte';
import { client } from '../fixtures/registry.js';

export type Inst = z.infer<typeof InstanceDto>;
export type PageT = z.infer<typeof PageDto>;

export function inst(id: string, over: Partial<Inst> = {}): Inst {
  return { id, moduleId: 'clock', pageId: 'p1', settings: {}, layout: { x: 0, y: 0, w: 3, h: 2 }, mobileOrder: 0, ...over };
}

export function page(id: string, instances: Inst[] = [], over: Partial<PageT> = {}): PageT {
  return { id, name: `Page ${id}`, icon: null, order: 0, ownerId: 'u1', shared: false, background: null, instances, ...over };
}

export const registry: HostRegistry = {
  clock: {
    manifest: { id: 'clock', name: 'Clock', tile: { default: { w: 3, h: 2 }, min: { w: 2, h: 1 }, max: { w: 4, h: 3 } } },
    // The tile host loads the client; a trivial one keeps the grid/pages tests free of failure tiles.
    load: () => Promise.resolve({ default: client('clock', GoodTile as never) }),
  },
};

export class FakeGrid implements GridLike {
  isStatic: boolean | null = null;
  widgets: HTMLElement[] = [];
  updates: { el: HTMLElement; item: Partial<GridItem> }[] = [];
  destroyed = false;
  private cb: ((items: Pick<GridItem, 'id' | 'x' | 'y' | 'w' | 'h'>[]) => void) | null = null;
  setStatic(v: boolean): void {
    this.isStatic = v;
  }
  makeWidget(el: HTMLElement): void {
    this.widgets.push(el);
  }
  removeWidget(el: HTMLElement): void {
    this.widgets = this.widgets.filter((w) => w !== el);
  }
  update(el: HTMLElement, item: Partial<GridItem>): void {
    this.updates.push({ el, item });
  }
  onChange(cb: (items: Pick<GridItem, 'id' | 'x' | 'y' | 'w' | 'h'>[]) => void): void {
    this.cb = cb;
  }
  destroy(): void {
    this.destroyed = true;
  }
  emit(items: Pick<GridItem, 'id' | 'x' | 'y' | 'w' | 'h'>[]): void {
    this.cb?.(items);
  }
}
