import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type Component } from 'svelte';
import { runClientContractSuite } from '@dash/module-kit/client';
import { loadFixture } from '@dash/module-kit/testing';
import { DashError, type DetailProps, type ModuleApi, type ModuleClient, type TileProps } from '@dash/contract';
import { identityT } from '@dash/ui';
import client from '../client/index.js';
import { reactiveProps } from './reactive.svelte.js';
import { parseQuickAdd } from '../client/model.js';
import { settings as settingsSchema, type ItemList, type Settings, type Snapshot, type WireItem } from '../manifest.js';

const moduleDir = import.meta.dirname + '/..';
runClientContractSuite(client, { moduleDir, tileFixture: 'tile', detailFixture: 'detail' });

const fixture = loadFixture<Snapshot>(moduleDir, 'tile');
const settings: Settings = settingsSchema.parse({});
const EPOCH = fixture.epoch;
const NOW = '2026-11-18T09:00:00.000Z';

const mounted: Array<() => void> = [];
beforeEach(() => {
  vi.setSystemTime(new Date(NOW)); // only the clock: timers stay real
});
afterEach(() => {
  vi.useRealTimers();
  while (mounted.length > 0) mounted.pop()?.();
  document.body.innerHTML = '';
});

function show(component: ModuleClient['Tile'] | ModuleClient['Detail'], props: object): HTMLElement {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(component as unknown as Component<Record<string, unknown>>, { target, props: props as Record<string, unknown> });
  mounted.push(() => void unmount(instance));
  flushSync();
  return target;
}

type Calls = { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
function fakeApi(over: Partial<Calls> = {}): Calls {
  const reject = () => vi.fn(() => Promise.reject(new Error('unexpected call')));
  return { get: reject(), post: reject(), put: reject(), patch: reject(), delete: reject(), ...over };
}
const asApi = (api: Calls): ModuleApi => api as unknown as ModuleApi;

function tileProps(over: Partial<Omit<TileProps<Snapshot, Settings>, 'api'>> & { api?: Calls } = {}): TileProps<Snapshot, Settings> {
  const { api = fakeApi(), ...rest } = over;
  return {
    data: fixture,
    updatedAt: NOW,
    stale: false,
    settings,
    instanceId: 'inst-1',
    level: 'edit',
    size: { w: 3, h: 4 },
    mode: 'day',
    api: asApi(api),
    t: identityT,
    locale: 'en',
    timeZone: 'UTC',
    isOwner: true,
    openDetail: () => undefined,
    ...rest,
  };
}

const wire = (over: Partial<WireItem> & { id: string; title: string }): WireItem => ({
  list: 'shopping', icon: null, note: null, qty: null, due: null, ownerId: 'u1', assigneeId: null, visibility: 'shared', done: false,
  doneAt: null, doneBy: null, version: 1, url: null, sourceKey: null, repeatEvery: null, repeatUnit: null, rotation: [], rotationIdx: 0,
  createdAt: NOW, updatedAt: NOW, bucket: 'none', ...over,
});
const stamp = { epoch: EPOCH, rev: 5, userId: 'u1' };
const itemList = (items: WireItem[], rev = 5, order: ItemList['order'] = {}): ItemList => ({ ...stamp, rev, items, order });

function detailProps(api: Calls, over: Partial<Omit<DetailProps<Snapshot, Settings>, 'api'>> = {}): DetailProps<Snapshot, Settings> {
  return {
    data: fixture, updatedAt: NOW, stale: false, settings, instanceId: 'inst-1', level: 'edit', mode: 'day', api: asApi(api), t: identityT, locale: 'en', timeZone: 'UTC',
    isOwner: true, params: {}, close: () => undefined, ...over,
  };
}
const USERS = [{ id: 'u1', name: 'Dana', handle: 'dani' }, { id: 'u2', name: 'Eli', handle: 'eli' }];
const detailApi = (list: ItemList, over: Partial<Calls> = {}) =>
  fakeApi({
    get: vi.fn((path: string) => Promise.resolve(path === '/users' ? USERS : list)),
    ...over,
  });
const byText = (root: ParentNode, selector: string, text: string): HTMLElement => {
  const el = [...root.querySelectorAll<HTMLElement>(selector)].find((e) => e.textContent?.trim() === text);
  if (!el) throw new Error(`no ${selector} with text "${text}"`);
  return el;
};
/** Lets every pending promise callback run, then flushes Svelte. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
  }
};

describe('Tile', () => {
  test('checkbox calls done with version', async () => {
    const api = fakeApi({ post: vi.fn(() => Promise.resolve(itemList([]))) });
    const root = show(client.Tile, tileProps({ api }));
    const box = root.querySelector<HTMLInputElement>('li[data-id="i3"] input[type=checkbox]')!;
    expect(box).toBeTruthy();
    box.click();
    await settle();
    expect(api.post).toHaveBeenCalledWith('/items/i3/done', { version: 4, done: true, timeZone: 'UTC' });
    expect(root.querySelector('li[data-id="i3"]')?.classList.contains('done')).toBe(true); // shown at once
  });

  test('quick add with @dani sets assignee', async () => {
    const api = fakeApi({ post: vi.fn(() => Promise.resolve(itemList([]))) });
    const root = show(client.Tile, tileProps({ api }));
    const input = root.querySelector<HTMLInputElement>('form input')!;
    input.value = 'Buy milk @dani';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(api.post).toHaveBeenCalledWith('/items', { list: 'week', title: 'Buy milk', assigneeHandle: 'dani', timeZone: 'UTC' });
    expect(input.value).toBe('');
  });

  test('quick add without a handle sends no assignee, and an empty title sends nothing', async () => {
    const api = fakeApi({ post: vi.fn(() => Promise.resolve(itemList([]))) });
    const root = show(client.Tile, tileProps({ api }));
    const input = root.querySelector<HTMLInputElement>('form input')!;
    const form = root.querySelector('form')!;
    input.value = '  @dani ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(api.post).not.toHaveBeenCalled();
    input.value = 'Plain';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(api.post).toHaveBeenCalledWith('/items', { list: 'week', title: 'Plain', timeZone: 'UTC' });
  });

  test('a failing done call shows an error and unticks; a 409 shows the hint instead', async () => {
    const post = vi.fn().mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new DashError('conflict', 'changed', { item: wire({ id: 'i3', title: 'Bins out' }) }));
    const root = show(client.Tile, tileProps({ api: fakeApi({ post }) }));
    root.querySelector<HTMLInputElement>('li[data-id="i3"] input')!.click();
    await settle();
    expect(root.querySelector('[role=alert]')?.textContent).toContain('Could not save');
    expect(root.querySelector('li[data-id="i3"]')?.classList.contains('done')).toBe(false);
    root.querySelector<HTMLInputElement>('li[data-id="i3"] input')!.click();
    await settle();
    expect(root.querySelector('[role=status]')?.textContent).toContain('Someone else changed');
  });

  test('groups with counts: overdue and today come first, counts come from the snapshot', () => {
    const root = show(client.Tile, tileProps());
    const heads = [...root.querySelectorAll('h4')].map((h) => h.textContent?.replace(/\s+/g, ' ').trim());
    expect(heads[0]).toBe('Overdue 1');
    expect(heads).toEqual(['Overdue 1', 'Today 1', 'This week 2', 'No date 1']);
    expect(root.querySelector('li[data-id="i1"]')?.classList.contains('overdue')).toBe(true);
  });

  test('view level and a non-owner see no controls but still the items', () => {
    for (const over of [{ level: 'view' as const }, { isOwner: false }]) {
      const root = show(client.Tile, tileProps(over));
      expect(root.querySelector('[data-edit]')).toBeNull();
      expect(root.querySelectorAll('li')).toHaveLength(4);
    }
  });

  test('a snapshot with an older rev than the one shown is ignored, a newer one applies', async () => {
    const target = document.body.appendChild(document.createElement('div'));
    const props = reactiveProps(tileProps());
    const instance = mount(client.Tile, { target, props });
    mounted.push(() => void unmount(instance));
    flushSync();
    expect(target.querySelector('li[data-id="i4"]')).toBeTruthy();
    props.data = { ...fixture, rev: fixture.rev - 1, items: fixture.items.slice(0, 1) };
    await tick();
    expect(target.querySelector('li[data-id="i4"]')).toBeTruthy();
    props.data = { ...fixture, rev: fixture.rev + 1, items: fixture.items.slice(0, 1) };
    await tick();
    expect(target.querySelector('li[data-id="i4"]')).toBeNull();
    props.data = { ...fixture, epoch: 'new-boot', rev: 0, items: fixture.items.slice(0, 2) }; // a restart wins even with a lower rev
    await tick();
    expect(target.querySelector('li[data-id="i2"]')).toBeTruthy();
  });

  test('at the minimum size a short flat list shows, without headers or quick add', () => {
    const root = show(client.Tile, tileProps({ size: { w: 2, h: 2 } }));
    expect(root.querySelectorAll('li')).toHaveLength(3);
    expect(root.querySelector('h4')).toBeNull();
    expect(root.querySelector('form')).toBeNull();
  });
});

describe('Detail', () => {
  test('409 refreshes the row and shows a hint', async () => {
    const milk = wire({ id: 'm1', title: 'Milk', version: 1 });
    const current = wire({ id: 'm1', title: 'Oat milk', version: 2, done: false });
    const post = vi.fn(() => Promise.reject(new DashError('conflict', 'changed', { item: current })));
    const root = show(client.Detail, detailProps(detailApi(itemList([milk]), { post }), { params: { list: 'shopping' } }));
    await settle();
    expect(root.querySelector('li[data-id="m1"] .title')?.textContent).toBe('Milk');
    root.querySelector<HTMLInputElement>('li[data-id="m1"] input[type=checkbox]')!.click();
    await settle();
    expect(post).toHaveBeenCalledWith('/items/m1/done', { version: 1, done: true, timeZone: 'UTC' });
    expect(root.querySelector('li[data-id="m1"] .title')?.textContent).toBe('Oat milk');
    expect(root.querySelector('[role=status]')?.textContent).toContain('Someone else changed');
    expect(root.querySelector('[role=alert]')).toBeNull();
  });

  test('store mode strikes items on tap', async () => {
    const items = [wire({ id: 'a', title: 'Eggs', version: 3 }), wire({ id: 'b', title: 'Bread' })];
    const post = vi.fn(() => new Promise<ItemList>(() => undefined)); // never answers: the strike is optimistic
    const root = show(client.Detail, detailProps(detailApi(itemList(items), { post }), { params: { list: 'shopping' } }));
    await settle();
    byText(root, 'button', 'Store mode').click();
    await settle();
    const store = root.querySelector<HTMLElement>('.store')!;
    expect(store).toBeTruthy();
    const eggs = byText(store, 'button.item', 'Eggs');
    expect(eggs.getAttribute('aria-pressed')).toBe('false');
    eggs.click();
    await settle();
    expect(post).toHaveBeenCalledWith('/items/a/done', { version: 3, done: true, timeZone: 'UTC' });
    expect(eggs.getAttribute('aria-pressed')).toBe('true');
    expect(eggs.classList.contains('struck')).toBe(true);
    expect(byText(store, 'button.item', 'Bread').classList.contains('struck')).toBe(false);
  });

  test('store mode answers a failed call by un-striking', async () => {
    const post = vi.fn(() => Promise.reject(new Error('offline')));
    const root = show(client.Detail, detailProps(detailApi(itemList([wire({ id: 'a', title: 'Eggs' })]), { post }), { params: { list: 'shopping' } }));
    await settle();
    byText(root, 'button', 'Store mode').click();
    await settle();
    const eggs = byText(root.querySelector<HTMLElement>('.store')!, 'button.item', 'Eggs');
    eggs.click();
    await settle();
    expect(eggs.getAttribute('aria-pressed')).toBe('false');
    expect(root.querySelector('[role=alert]')).toBeTruthy();
  });

  test('tabs per list; the caller order from the server is applied; move down saves a new order', async () => {
    const items = [wire({ id: 'a', title: 'A' }), wire({ id: 'b', title: 'B' }), wire({ id: 'c', title: 'C' })];
    const put = vi.fn((_path: string, body: { ids: string[] }) => Promise.resolve(itemList(items, 5, { shopping: body.ids })));
    const root = show(client.Detail, detailProps(detailApi(itemList(items, 5, { shopping: ['c', 'a'] }), { put }), { params: { list: 'shopping' } }));
    await settle();
    expect([...root.querySelectorAll('[role=tab]')].map((e) => e.textContent)).toEqual(['Week', 'Month', 'Deadline', 'Shopping', 'Chores']);
    expect([...root.querySelectorAll('li .title')].map((e) => e.textContent)).toEqual(['C', 'A', 'B']);
    root.querySelector<HTMLElement>('li[data-id="c"] button[aria-label^="Move down"]')!.click();
    await settle();
    expect(put).toHaveBeenCalledWith('/order', { list: 'shopping', ids: ['a', 'c', 'b'], timeZone: 'UTC' });
    expect([...root.querySelectorAll('li .title')].map((e) => e.textContent)).toEqual(['A', 'C', 'B']);
  });

  test('add item sends the editor values with the list and the time zone', async () => {
    const post = vi.fn<(path: string, body: unknown) => Promise<ItemList>>(() => Promise.resolve(itemList([])));
    const root = show(client.Detail, detailProps(detailApi(itemList([]), { post }), { params: { list: 'week' } }));
    await settle();
    byText(root, 'button', 'Add item').click();
    await settle();
    const title = root.querySelector<HTMLInputElement>('form input[maxlength="200"]')!;
    title.value = 'Plan the trip';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(post).toHaveBeenCalledWith('/items', expect.objectContaining({ list: 'week', title: 'Plan the trip', assigneeId: null, timeZone: 'UTC' }));
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty('due'); // untouched: the server's implicit due applies
    expect(root.querySelector('form')).toBeNull(); // editor closed
  });

  test('on a shared page (not owner) the snapshot is shown read-only and no route is called', async () => {
    const api = fakeApi();
    const root = show(client.Detail, detailProps(api, { isOwner: false, params: { list: 'week' } }));
    await settle();
    expect(api.get).not.toHaveBeenCalled();
    expect(root.querySelector('li[data-id="i2"]')).toBeTruthy();
    expect(root.querySelector('[data-edit]')).toBeNull();
  });
});

describe('parseQuickAdd', () => {
  test('only @handle is understood, wherever it is', () => {
    expect(parseQuickAdd('Buy milk @Dani')).toEqual({ title: 'Buy milk', handle: 'dani' });
    expect(parseQuickAdd('@eli take bins out')).toEqual({ title: 'take bins out', handle: 'eli' });
    expect(parseQuickAdd('Pay rent !fri')).toEqual({ title: 'Pay rent !fri', handle: null });
    expect(parseQuickAdd('mail a@b.de now')).toEqual({ title: 'mail a@b.de now', handle: null });
  });
});
