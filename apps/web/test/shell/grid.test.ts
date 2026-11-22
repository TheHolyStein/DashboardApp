import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import {
  clampLayout,
  createGridController,
  detectSwipe,
  firstFreeSlot,
  fromGridItems,
  sortForMobile,
  toGridItems,
} from '../../src/lib/grid.js';
import { pages } from '../../src/lib/pages.svelte.js';
import { session } from '../../src/lib/session.svelte.js';
import Grid from '../../src/shell/Grid.svelte';
import { FakeGrid, inst, page, registry } from './pageFixtures.js';
import { signIn } from './helpers.js';

const limits = { min: { w: 2, h: 1 }, max: { w: 6, h: 4 } };

describe('grid.ts', () => {
  it('clampLayout keeps w/h within min..max and x + w inside the grid', () => {
    expect(clampLayout({ x: 0, y: 0, w: 99, h: 99 }, limits)).toEqual({ x: 0, y: 0, w: 6, h: 4 });
    expect(clampLayout({ x: 0, y: 0, w: 0, h: 0 }, limits)).toEqual({ x: 0, y: 0, w: 2, h: 1 });
    expect(clampLayout({ x: 11, y: -3, w: 4, h: 2 }, limits)).toEqual({ x: 8, y: 0, w: 4, h: 2 });
    expect(clampLayout({ x: -5, y: 1, w: 3, h: 2 }, { min: { w: 1, h: 1 }, max: { w: 20, h: 4 } }).x).toBe(0);
    const wide = clampLayout({ x: 7, y: 0, w: 20, h: 1 }, { min: { w: 1, h: 1 }, max: { w: 20, h: 4 } });
    expect(wide.w).toBe(12);
    expect(wide.x + wide.w).toBeLessThanOrEqual(12);
  });

  it('mobile order follows mobileOrder, ties by y then x then id', () => {
    const a = inst('a', { mobileOrder: 1, layout: { x: 0, y: 0, w: 1, h: 1 } });
    const b = inst('b', { mobileOrder: 0, layout: { x: 5, y: 9, w: 1, h: 1 } });
    const c = inst('c', { mobileOrder: 1, layout: { x: 0, y: 0, w: 1, h: 1 } });
    const d = inst('d', { mobileOrder: 1, layout: { x: 4, y: 0, w: 1, h: 1 } });
    const e = inst('e', { mobileOrder: 1, layout: { x: 0, y: 2, w: 1, h: 1 } });
    expect(sortForMobile([e, d, c, b, a]).map((i) => i.id)).toEqual(['b', 'a', 'c', 'd', 'e']);
  });

  it('firstFreeSlot on an empty page is the origin', () => {
    expect(firstFreeSlot([], { w: 3, h: 2 })).toEqual({ x: 0, y: 0 });
  });

  it('firstFreeSlot skips occupied cells on a crowded page', () => {
    const items = [
      inst('a', { layout: { x: 0, y: 0, w: 6, h: 2 } }),
      inst('b', { layout: { x: 6, y: 0, w: 4, h: 1 } }),
    ];
    expect(firstFreeSlot(items, { w: 2, h: 1 })).toEqual({ x: 10, y: 0 });
    expect(firstFreeSlot(items, { w: 4, h: 1 })).toEqual({ x: 6, y: 1 });
    expect(firstFreeSlot(items, { w: 8, h: 1 })).toEqual({ x: 0, y: 2 });
    const full = [inst('f', { layout: { x: 0, y: 0, w: 12, h: 3 } })];
    expect(firstFreeSlot(full, { w: 12, h: 2 })).toEqual({ x: 0, y: 3 });
  });

  it('toGridItems and fromGridItems map instances and grid items', () => {
    const items = toGridItems([inst('a', { layout: { x: 1, y: 2, w: 3, h: 2 } }), inst('z', { moduleId: 'nope' })], registry);
    expect(items[0]).toMatchObject({ id: 'a', x: 1, y: 2, w: 3, h: 2, minW: 2, maxW: 4, minH: 1, maxH: 3 });
    expect(items[1]).toMatchObject({ minW: 1, maxW: 12 }); // unknown module: neutral limits
    expect(fromGridItems([{ id: 'a', x: 1, y: 2, w: 3, h: 4 }])).toEqual([{ id: 'a', layout: { x: 1, y: 2, w: 3, h: 4 } }]);
  });

  it('detectSwipe needs 60 px and a mostly horizontal move', () => {
    expect(detectSwipe(-80, 5)).toBe('next');
    expect(detectSwipe(80, 5)).toBe('prev');
    expect(detectSwipe(-59, 0)).toBeNull();
    expect(detectSwipe(-70, 90)).toBeNull();
  });
});

describe('createGridController', () => {
  function setup() {
    const g = new FakeGrid();
    const onLayout = vi.fn();
    const root = document.createElement('div');
    const ctl = createGridController(() => g, root, onLayout);
    const [item] = toGridItems([inst('a')], registry);
    const el = document.createElement('div');
    ctl.sync([{ item: item!, el }]);
    return { g, ctl, onLayout, el };
  }

  it('is static until made editable', () => {
    const { g, ctl } = setup();
    expect(g.isStatic).toBe(true);
    ctl.setEditable(true);
    expect(g.isStatic).toBe(false);
    ctl.setEditable(false);
    expect(g.isStatic).toBe(true);
  });

  it('resize clamps to manifest min/max', () => {
    const { g, onLayout } = setup();
    g.emit([{ id: 'a', x: 10, y: 0, w: 9, h: 9 }]);
    expect(onLayout).toHaveBeenLastCalledWith([{ id: 'a', layout: { x: 8, y: 0, w: 4, h: 3 } }]);
    g.emit([{ id: 'a', x: 0, y: 1, w: 1, h: 0 }]);
    expect(onLayout).toHaveBeenLastCalledWith([{ id: 'a', layout: { x: 0, y: 1, w: 2, h: 1 } }]);
  });

  it('adds, updates and removes widgets on sync', () => {
    const { g, ctl, el } = setup();
    expect(g.widgets).toEqual([el]);
    const [moved] = toGridItems([inst('a', { layout: { x: 4, y: 0, w: 3, h: 2 } })], registry);
    ctl.sync([{ item: moved!, el }]);
    expect(g.updates).toHaveLength(1);
    ctl.sync([]);
    expect(g.widgets).toEqual([]);
  });
});

describe('Grid.svelte', () => {
  async function mount(p: ReturnType<typeof page>) {
    const g = new FakeGrid();
    const r = render(Grid, { page: p, modules: registry, gridFactory: () => g });
    await waitFor(() => expect(g.widgets.length).toBe(p.instances.length));
    return { g, ...r };
  }
  const twoTiles = () => [inst('a'), inst('b', { layout: { x: 3, y: 0, w: 3, h: 2 } })];

  it('renders one tile frame per instance', async () => {
    signIn();
    const { container } = await mount(page('p1', twoTiles()));
    expect(container.querySelectorAll('[data-instance-id]')).toHaveLength(2);
  });

  it('drag disabled outside edit mode', async () => {
    signIn();
    pages.setEditing(false);
    const { g } = await mount(page('p1', twoTiles()));
    expect(g.isStatic).toBe(true);
    pages.setEditing(true);
    await waitFor(() => expect(g.isStatic).toBe(false));
    pages.setEditing(false);
    await waitFor(() => expect(g.isStatic).toBe(true));
  });

  it('a non-owner cannot drag on a shared page even in edit mode', async () => {
    signIn({ id: 'u1' });
    pages.setEditing(true);
    const { g } = await mount(page('p9', twoTiles(), { ownerId: 'u2', shared: true }));
    expect(session.me?.id).toBe('u1');
    expect(g.isStatic).toBe(true);
    pages.setEditing(false);
  });

  it('unknown module renders a "module unavailable" tile', async () => {
    signIn();
    const { getByText } = await mount(page('p1', [inst('x', { moduleId: 'ghost' })]));
    expect(getByText('Module unavailable')).toBeTruthy();
  });

  it('a layout change is clamped and saved for the whole page', async () => {
    signIn();
    pages.setEditing(true);
    const save = vi.spyOn(pages, 'saveLayout').mockImplementation(() => {});
    const { g } = await mount(page('p1', twoTiles()));
    g.emit([{ id: 'a', x: 0, y: 0, w: 9, h: 9 }]);
    expect(save).toHaveBeenCalledWith('p1', [
      { id: 'a', layout: { x: 0, y: 0, w: 4, h: 3 }, mobileOrder: 0 },
      { id: 'b', layout: { x: 3, y: 0, w: 3, h: 2 }, mobileOrder: 0 },
    ]);
    save.mockRestore();
    pages.setEditing(false);
  });

  it('grid change events while not editing or on a foreign shared page send no save', async () => {
    signIn();
    const save = vi.spyOn(pages, 'saveLayout').mockImplementation(() => {});
    pages.setEditing(false);
    const own = await mount(page('p1', twoTiles()));
    own.g.emit([{ id: 'a', x: 1, y: 0, w: 3, h: 2 }]);
    expect(save).not.toHaveBeenCalled();
    own.unmount();
    pages.setEditing(true);
    const foreign = await mount(page('p9', twoTiles(), { ownerId: 'u2', shared: true }));
    foreign.g.emit([{ id: 'a', x: 1, y: 0, w: 3, h: 2 }]);
    expect(save).not.toHaveBeenCalled();
    save.mockRestore();
    pages.setEditing(false);
  });

  it('a failed gridstack load shows an error and retry works', async () => {
    signIn();
    const g = new FakeGrid();
    const loadGrid = vi.fn().mockRejectedValueOnce(new Error('chunk')).mockResolvedValue(() => g);
    const { findByRole, queryByRole } = render(Grid, { page: page('p1', twoTiles()), modules: registry, loadGrid });
    const retry = await findByRole('button', { name: 'Retry' });
    expect(queryByRole('alert')).toBeTruthy();
    await fireEvent.click(retry);
    await waitFor(() => expect(g.widgets.length).toBe(2));
    expect(queryByRole('alert')).toBeNull();
  });
});
