import { GRID_COLUMNS, type InstanceDto, type LayoutDto, type ModuleId, type ModuleManifest, type TileSize } from '@dash/contract';
import type { z } from 'zod';

export type Instance = z.infer<typeof InstanceDto>;
export type Layout = z.infer<typeof LayoutDto>;
export interface TileLimits { min: TileSize; max: TileSize }
/** The part of a client module the shell needs; the generated `clientModules` satisfies it. */
export type ModuleRegistry = Record<ModuleId, { manifest: Pick<ModuleManifest, 'id' | 'name' | 'tile'> }>;

/** Used for an instance whose module is not in the registry. */
export const DEFAULT_LIMITS: TileLimits = { min: { w: 1, h: 1 }, max: { w: GRID_COLUMNS, h: 12 } };
export const SWIPE_THRESHOLD_PX = 60;
export const SWIPE_IGNORE_SELECTOR = '[data-no-swipe], input, textarea, select';

export function tileLimits(registry: ModuleRegistry, moduleId: ModuleId): TileLimits {
  const m = registry[moduleId];
  return m ? { min: m.manifest.tile.min, max: m.manifest.tile.max } : DEFAULT_LIMITS;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));

export function clampLayout(layout: Layout, tile: TileLimits): Layout {
  const w = clamp(layout.w, tile.min.w, Math.min(tile.max.w, GRID_COLUMNS));
  const h = clamp(layout.h, tile.min.h, tile.max.h);
  return { x: clamp(layout.x, 0, GRID_COLUMNS - w), y: Math.max(0, layout.y), w, h };
}

export function sortForMobile<T extends Pick<Instance, 'id' | 'layout' | 'mobileOrder'>>(instances: readonly T[]): T[] {
  return [...instances].sort(
    (a, b) =>
      a.mobileOrder - b.mobileOrder ||
      a.layout.y - b.layout.y ||
      a.layout.x - b.layout.x ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/** First position (rows top-down, columns left-to-right) where a `size` tile fits without overlap. */
export function firstFreeSlot(instances: readonly Pick<Instance, 'layout'>[], size: TileSize): { x: number; y: number } {
  const w = Math.min(Math.max(size.w, 1), GRID_COLUMNS);
  const h = Math.max(size.h, 1);
  const overlaps = (x: number, y: number): boolean =>
    instances.some((i) => {
      const l = i.layout;
      return x < l.x + l.w && x + w > l.x && y < l.y + l.h && y + h > l.y;
    });
  const bottom = instances.reduce((m, i) => Math.max(m, i.layout.y + i.layout.h), 0);
  for (let y = 0; y <= bottom; y++) {
    for (let x = 0; x + w <= GRID_COLUMNS; x++) if (!overlaps(x, y)) return { x, y };
  }
  return { x: 0, y: bottom };
}

/** The item shape used by the grid library (gridstack `GridStackWidget` subset). */
export interface GridItem {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW: number;
  maxW: number;
  minH: number;
  maxH: number;
}

export function toGridItems(instances: readonly Instance[], registry: ModuleRegistry): GridItem[] {
  return instances.map((i) => {
    const { min, max } = tileLimits(registry, i.moduleId);
    return { id: i.id, ...i.layout, minW: min.w, maxW: Math.min(max.w, GRID_COLUMNS), minH: min.h, maxH: max.h };
  });
}

export function fromGridItems(items: readonly Pick<GridItem, 'id' | 'x' | 'y' | 'w' | 'h'>[]): { id: string; layout: Layout }[] {
  return items.map((g) => ({ id: g.id, layout: { x: g.x, y: g.y, w: g.w, h: g.h } }));
}

/** Horizontal swipe: 'next' for a left swipe, 'prev' for a right swipe, null if too short or mostly vertical. */
export function detectSwipe(dx: number, dy: number): 'next' | 'prev' | null {
  if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dy) > Math.abs(dx)) return null;
  return dx < 0 ? 'next' : 'prev';
}

/** Thin adapter over the grid library; tests inject a fake. */
export interface GridLike {
  setStatic(isStatic: boolean): void;
  makeWidget(el: HTMLElement): void;
  removeWidget(el: HTMLElement): void;
  update(el: HTMLElement, item: Partial<GridItem>): void;
  /** Called with the changed items after a drag or resize. */
  onChange(cb: (items: Pick<GridItem, 'id' | 'x' | 'y' | 'w' | 'h'>[]) => void): void;
  destroy(): void;
}
export type GridFactory = (el: HTMLElement) => GridLike;

export interface GridEntry { item: GridItem; el: HTMLElement }

export function createGridController(
  factory: GridFactory,
  root: HTMLElement,
  onLayout: (items: { id: string; layout: Layout }[]) => void,
) {
  const grid = factory(root);
  const known = new Map<string, { el: HTMLElement; item: GridItem }>();
  grid.onChange((changed) => {
    const out = fromGridItems(
      changed.flatMap((c) => {
        const k = known.get(c.id);
        if (!k) return [];
        const layout = clampLayout(c, { min: { w: k.item.minW, h: k.item.minH }, max: { w: k.item.maxW, h: k.item.maxH } });
        k.item = { ...k.item, ...layout };
        return [{ id: c.id, ...layout }];
      }),
    );
    if (out.length) onLayout(out);
  });
  grid.setStatic(true);
  return {
    setEditable(on: boolean): void {
      grid.setStatic(!on);
    },
    sync(entries: readonly GridEntry[]): void {
      const ids = new Set(entries.map((e) => e.item.id));
      for (const [id, k] of known) {
        if (!ids.has(id)) {
          try {
            grid.removeWidget(k.el);
          } catch {
            /* element already gone */
          }
          known.delete(id);
        }
      }
      for (const { item, el } of entries) {
        const prev = known.get(item.id);
        if (!prev || prev.el !== el) {
          if (prev) grid.removeWidget(prev.el);
          known.set(item.id, { el, item });
          grid.makeWidget(el);
        } else if (JSON.stringify(prev.item) !== JSON.stringify(item)) {
          prev.item = item;
          grid.update(el, item);
        }
      }
    },
    destroy(): void {
      known.clear();
      grid.destroy();
    },
  };
}

/** Minimal shapes of `MediaQueryList` / `IntersectionObserver` the shell uses (injectable in tests). */
export interface MediaQueryLike {
  matches: boolean;
  addEventListener(type: 'change', fn: (e: Event) => void): void;
  removeEventListener(type: 'change', fn: (e: Event) => void): void;
}
export interface IntersectionLike {
  observe(el: Element): void;
  disconnect(): void;
}
export type IntersectionCallback = (entries: IntersectionObserverEntry[]) => void;
export type MediaFactory = (query: string) => MediaQueryLike;
export type ObserverFactory = (cb: IntersectionCallback) => IntersectionLike;
