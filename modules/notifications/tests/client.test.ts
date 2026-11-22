import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { runClientContractSuite } from '@dash/module-kit/client';
import { loadFixture } from '@dash/module-kit/testing';
import { DashError, type DetailProps, type ModuleApi, type TileProps } from '@dash/contract';
import { identityT } from '@dash/ui';
import client from '../client/index.js';
import type { ListPage, MutesState, NotificationItem, ReadResult, Snapshot } from '../manifest.js';

const moduleDir = import.meta.dirname + '/..';
runClientContractSuite(client, { moduleDir, tileFixture: 'tile' });

const NOW = '2026-11-12T08:00:00.000Z';
const fixture = loadFixture<Snapshot>(moduleDir, 'tile');
const EMPTY: Snapshot = { epoch: fixture.epoch, rev: 1, unread: 0, latest: [] };

function tileProps(over: Partial<TileProps<Snapshot>> = {}): TileProps<Snapshot> {
  return {
    data: fixture,
    updatedAt: NOW,
    stale: false,
    settings: {},
    level: 'view',
    size: { w: 3, h: 2 },
    mode: 'day',
    instanceId: 'i1',
    api: {} as ModuleApi,
    t: identityT,
    locale: 'en',
    timeZone: 'UTC',
    isOwner: true,
    openDetail: () => undefined,
    ...over,
  };
}

const item = (id: string, moduleId: string, level: NotificationItem['level'], title: string, createdAt: string, readAt: string | null = null): NotificationItem => ({
  id, moduleId, level, title, body: null, titleKey: null, bodyKey: null, vars: null, url: null, createdAt, readAt,
});
const ITEMS: NotificationItem[] = [
  item('n3', 'nas', 'critical', 'NAS failed', '2026-11-12T07:50:00.000Z'),
  item('n2', 'weather', 'warn', 'Storm tonight', '2026-11-12T07:40:00.000Z', '2026-11-12T07:41:00.000Z'),
  item('n1', 'clock', 'info', 'Pasta', '2026-11-11T18:05:00.000Z'),
];
const page = (items: NotificationItem[], over: Partial<ListPage> = {}): ListPage => ({ epoch: fixture.epoch, rev: 4, items, next: null, ...over });
const mutes = (m: Record<string, string>, rev = 4): MutesState => ({ epoch: fixture.epoch, rev, mutes: m });

/** A fake of the module's routes; every call is recorded on the spies. */
function fakeApi(over: { list?: (q: Record<string, unknown> | undefined) => Promise<ListPage>; mutes?: MutesState } = {}) {
  const get = vi.fn((path: string, query?: Record<string, unknown>) => {
    if (path === '/list') return (over.list ?? (() => Promise.resolve(page(ITEMS))))(query);
    if (path === '/mutes') return Promise.resolve(over.mutes ?? mutes({}));
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  const post = vi.fn((...args: unknown[]) => {
    void args;
    return Promise.resolve({ epoch: fixture.epoch, rev: 5, unread: 0 } satisfies ReadResult);
  });
  const put = vi.fn((...args: unknown[]) => {
    const b = args[1] as { moduleId: string; hours: number | 'forever' | null };
    return Promise.resolve(mutes(b.hours === null ? {} : { [b.moduleId]: b.hours === 'forever' ? 'forever' : '2026-11-12T16:00:00.000Z' }, 5));
  });
  return { api: { get, post, put } as unknown as ModuleApi, get, post, put };
}

function detailProps(over: Partial<DetailProps<Snapshot>> = {}, api: ModuleApi = fakeApi().api): DetailProps<Snapshot> {
  return {
    instanceId: 'i1',
    data: fixture,
    updatedAt: NOW,
    stale: false,
    settings: {},
    level: 'view',
    mode: 'day',
    api,
    t: identityT,
    locale: 'en',
    timeZone: 'UTC',
    isOwner: true,
    params: {},
    close: () => undefined,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Tile', () => {
  test('tile shows the unread count and the latest three with their level', () => {
    render(client.Tile, { props: tileProps() });
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('unread')).toBeTruthy();
    for (const title of ['NAS failed', 'Storm tonight', 'Pasta']) expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText('Critical')).toBeTruthy();
    expect(screen.getByText('Warning')).toBeTruthy();
    const row = screen.getByText('NAS failed').closest('li');
    expect(row?.className).toContain('critical');
  });

  test('tile shows at most three at the default size and five when it is tall', () => {
    const latest = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, level: 'info', title: `Item ${i}`, moduleId: 'nas', createdAt: NOW }));
    const { unmount } = render(client.Tile, { props: tileProps({ data: { ...EMPTY, unread: 5, latest } }) });
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    unmount();
    render(client.Tile, { props: tileProps({ size: { w: 3, h: 4 }, data: { ...EMPTY, unread: 5, latest } }) });
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  test('at the minimum size (2x1) only the count is shown', () => {
    render(client.Tile, { props: tileProps({ size: { w: 2, h: 1 } }) });
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.queryByText('NAS failed')).toBeNull();
  });

  test('with nothing unread the tile says everything is read', () => {
    render(client.Tile, { props: tileProps({ data: EMPTY }) });
    expect(screen.getByText('All caught up')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  test('without data the tile says it is waiting', () => {
    render(client.Tile, { props: tileProps({ data: undefined, updatedAt: null }) });
    expect(screen.getByText('Waiting for notifications…')).toBeTruthy();
  });

  test('a snapshot with an older rev than the one shown is ignored, a newer one and a new epoch apply', async () => {
    const { rerender } = render(client.Tile, { props: tileProps({ data: { ...EMPTY, rev: 5, unread: 7 } }) });
    expect(screen.getByText('7')).toBeTruthy();
    await rerender(tileProps({ data: { ...EMPTY, rev: 4, unread: 2 } }));
    expect(screen.getByText('7')).toBeTruthy();
    await rerender(tileProps({ data: { ...EMPTY, rev: 6, unread: 1 } }));
    expect(screen.getByText('1')).toBeTruthy();
    await rerender(tileProps({ data: { ...EMPTY, epoch: 'boot-2', rev: 1, unread: 9 } }));
    expect(screen.getByText('9')).toBeTruthy();
  });

  test('the count and the times follow the locale of the user', () => {
    render(client.Tile, { props: tileProps({ locale: 'de-DE', data: { ...EMPTY, unread: 1234 } }) });
    expect(screen.getByText('1.234')).toBeTruthy();
  });
});

describe('Detail', () => {
  test('detail groups notifications by day, newest first, with level words and modules', async () => {
    render(client.Detail, { props: detailProps() });
    await waitFor(() => expect(screen.getByText('NAS failed')).toBeTruthy());
    const headings = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(headings).toEqual(['Thursday, November 12', 'Wednesday, November 11']);
    expect(screen.getByText('Pasta')).toBeTruthy();
    expect(screen.getAllByText('Critical').length).toBeGreaterThan(0);
  });

  test('a notification with a translation key is shown through t()', async () => {
    const keyed = { ...item('k1', 'clock', 'info', 'Pasta', NOW), titleKey: 'm.clock.notify.finished', vars: { label: 'Eggs' } };
    const t = vi.fn((key: string, fallback: string, vars?: Record<string, string | number>) =>
      key === 'm.clock.notify.finished' ? `Timer ${String(vars?.['label'])} done` : identityT(key, fallback, vars));
    const { api } = fakeApi({ list: () => Promise.resolve(page([keyed])) });
    render(client.Detail, { props: detailProps({ t }, api) });
    await waitFor(() => expect(screen.getByText('Timer Eggs done')).toBeTruthy());
  });

  test('mark all read posts ids "all" and shows the items as read', async () => {
    const { api, post } = fakeApi();
    render(client.Detail, { props: detailProps({}, api) });
    await waitFor(() => expect(screen.getByText('NAS failed')).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/read', { ids: 'all' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark read' })).toBeNull());
  });

  test('mark one read posts its id', async () => {
    const { api, post } = fakeApi();
    render(client.Detail, { props: detailProps({}, api) });
    await waitFor(() => expect(screen.getByText('NAS failed')).toBeTruthy());
    const row = screen.getByText('NAS failed').closest('li') as HTMLElement;
    await fireEvent.click(within(row).getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/read', { ids: ['n3'] }));
  });

  test('filter by module asks the server, filter by level and unread only work on what is loaded', async () => {
    const { api, get } = fakeApi();
    render(client.Detail, { props: detailProps({}, api) });
    await waitFor(() => expect(screen.getByText('NAS failed')).toBeTruthy());

    await fireEvent.change(screen.getByLabelText('Module'), { target: { value: 'nas' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/list', { moduleId: 'nas' }));

    await fireEvent.change(screen.getByLabelText('Module'), { target: { value: '' } });
    await waitFor(() => expect(screen.getByText('Pasta')).toBeTruthy());
    await fireEvent.change(screen.getByLabelText('Level'), { target: { value: 'warn' } });
    expect(screen.queryByText('Pasta')).toBeNull();
    expect(screen.getByText('Storm tonight')).toBeTruthy();

    await fireEvent.change(screen.getByLabelText('Level'), { target: { value: '' } });
    await fireEvent.click(screen.getByLabelText('Unread only'));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/list', { unreadOnly: 'true' }));
  });

  test('load more asks for the next page with the cursor and appends', async () => {
    const first = page(ITEMS.slice(0, 2), { next: '2026-11-12T07:40:00.000Z' });
    const second = page(ITEMS.slice(2));
    const list = vi.fn((q?: Record<string, unknown>) => Promise.resolve(q?.['before'] ? second : first));
    const { api, get } = fakeApi({ list });
    render(client.Detail, { props: detailProps({}, api) });
    await waitFor(() => expect(screen.getByText('NAS failed')).toBeTruthy());
    expect(screen.queryByText('Pasta')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText('Pasta')).toBeTruthy());
    expect(get).toHaveBeenCalledWith('/list', { before: '2026-11-12T07:40:00.000Z' });
    expect(screen.getByText('NAS failed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  test('the mute menu mutes a module forever and unmutes it again', async () => {
    const { api, put } = fakeApi();
    render(client.Detail, { props: detailProps({}, api) });
    await waitFor(() => expect(screen.getByText('NAS failed')).toBeTruthy());
    const select = screen.getByLabelText<HTMLSelectElement>('Mute nas');
    expect(select.value).toBe('off');
    await fireEvent.change(select, { target: { value: 'forever' } });
    await waitFor(() => expect(put).toHaveBeenCalledWith('/mutes', { moduleId: 'nas', hours: 'forever' }));
    await waitFor(() => expect(screen.getByLabelText<HTMLSelectElement>('Mute nas').value).toBe('forever'));
    await fireEvent.change(screen.getByLabelText('Mute nas'), { target: { value: 'off' } });
    await waitFor(() => expect(put).toHaveBeenLastCalledWith('/mutes', { moduleId: 'nas', hours: null }));
  });

  test('a timed mute sends the number of hours, not a time', async () => {
    const { api, put } = fakeApi();
    render(client.Detail, { props: detailProps({}, api) });
    await waitFor(() => expect(screen.getByText('NAS failed')).toBeTruthy());
    await fireEvent.change(screen.getByLabelText('Mute nas'), { target: { value: '8h' } });
    await waitFor(() => expect(put).toHaveBeenCalledWith('/mutes', { moduleId: 'nas', hours: 8 }));
  });

  test('a module that is muted shows as muted even when it has no notification on the page', async () => {
    const { api } = fakeApi({ mutes: mutes({ calendar: 'forever' }) });
    render(client.Detail, { props: detailProps({}, api) });
    await waitFor(() => expect(screen.getByLabelText<HTMLSelectElement>('Mute calendar').value).toBe('forever'));
  });

  test('a failed fetch shows an error line, a failed mark read too, and nothing crashes', async () => {
    const failing = fakeApi({ list: () => Promise.reject(new DashError('internal', 'boom')) });
    render(client.Detail, { props: detailProps({}, failing.api) });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not load your notifications.'));
    cleanup();

    const { api, post } = fakeApi();
    post.mockRejectedValueOnce(new DashError('internal', 'boom'));
    render(client.Detail, { props: detailProps({}, api) });
    await waitFor(() => expect(screen.getByText('NAS failed')).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not save your change.'));
  });

  test('a new snapshot rev loads the first page again', async () => {
    const { api, get } = fakeApi();
    const { rerender } = render(client.Detail, { props: detailProps({}, api) });
    await waitFor(() => expect(get.mock.calls.filter((c) => c[0] === '/list')).toHaveLength(1));
    await rerender(detailProps({ data: { ...fixture, rev: 9 } }, api));
    await waitFor(() => expect(get.mock.calls.filter((c) => c[0] === '/list')).toHaveLength(2));
  });

  test('on a shared page only the snapshot is shown and no route is called', async () => {
    const { api, get, post, put } = fakeApi();
    render(client.Detail, { props: detailProps({ isOwner: false }, api) });
    await vi.advanceTimersByTimeAsync(0);
    expect(get).not.toHaveBeenCalled();
    expect(screen.getByText('NAS failed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
