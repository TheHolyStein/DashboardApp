import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { runClientContractSuite } from '@dash/module-kit/client';
import { loadFixture } from '@dash/module-kit/testing';
import { DashError, type DetailProps, type ModuleApi, type TileProps } from '@dash/contract';
import { identityT } from '@dash/ui';
import client from '../client/index.js';
import { settings as settingsSchema, type DayDetail, type Settings, type Snapshot } from '../manifest.js';

const moduleDir = import.meta.dirname + '/..';
runClientContractSuite(client, { moduleDir, tileFixture: 'tile' });

const START = '2026-11-12T07:30:00.000Z';
const fixture = loadFixture<Snapshot>(moduleDir, 'tile');
const settings: Settings = settingsSchema.parse({});
const EMPTY: Snapshot = {
  epoch: fixture.epoch,
  rev: 1,
  greeting: 'day',
  date: '2026-11-12',
  next: null,
  eventsToday: 0,
  todos: { due: [], overdue: 0 },
  weatherHint: null,
  pins: [],
  alerts: [],
};

function tileProps(over: Partial<TileProps<Snapshot, Settings>> = {}): TileProps<Snapshot, Settings> {
  return {
    data: fixture,
    updatedAt: START,
    stale: false,
    settings,
    level: 'view',
    size: { w: 6, h: 2 },
    mode: 'day',
    api: {} as ModuleApi,
    t: identityT,
    locale: 'en',
    timeZone: 'UTC',
    isOwner: true,
    openDetail: () => undefined,
    ...over,
  };
}

const DAY: DayDetail = {
  epoch: fixture.epoch,
  rev: 3,
  date: '2026-11-12',
  today: [
    { uid: 'a', title: 'All day thing', start: '2026-11-12', end: '2026-11-13', allDay: true },
    { uid: 'b', title: 'Team standup', start: '2026-11-12T08:00:00.000Z', end: '2026-11-12T08:15:00.000Z', allDay: false },
  ],
  tomorrow: [{ uid: 'c', title: 'Dentist', start: '2026-11-13T09:30:00.000Z', end: '2026-11-13T10:00:00.000Z', allDay: false }],
  todos: fixture.todos,
  alerts: fixture.alerts,
};

function detailProps(over: Partial<DetailProps<Snapshot, Settings>> = {}, api?: Partial<ModuleApi>): DetailProps<Snapshot, Settings> {
  return {
    data: fixture,
    updatedAt: START,
    stale: false,
    settings,
    level: 'view',
    mode: 'day',
    api: { get: () => Promise.resolve(DAY), ...api } as ModuleApi,
    t: identityT,
    locale: 'en',
    timeZone: 'UTC',
    isOwner: true,
    params: {},
    close: () => undefined,
    ...over,
  };
}

/** A spy usable as `api.get`: the route answers with whatever the test needs, whatever type the caller asks for. */
const apiGet = (impl: () => Promise<unknown>) => vi.fn(impl) as unknown as ModuleApi['get'] & ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date(START));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Tile', () => {
  test('tile shows the greeting, the date and the next event with a countdown', () => {
    render(client.Tile, { props: tileProps() });
    expect(screen.getByText('Good morning')).toBeTruthy();
    expect(screen.getByText('Thursday, November 12')).toBeTruthy();
    expect(screen.getByText('Team standup')).toBeTruthy();
    expect(screen.getByText('in 30 min')).toBeTruthy();
  });

  test('the countdown moves on while the tile stays open', async () => {
    render(client.Tile, { props: tileProps() });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(screen.getByText('in 20 min')).toBeTruthy();
  });

  test('tile shows todos, weather hint, pin and alerts at the default size', () => {
    render(client.Tile, { props: tileProps() });
    expect(screen.getByText('3 events today')).toBeTruthy();
    expect(screen.getByText('2 to do, 1 overdue')).toBeTruthy();
    expect(screen.getByText('Rain expected around 10:00 AM')).toBeTruthy();
    expect(screen.getByText('Anna birthday')).toBeTruthy();
    expect(screen.getByText('Smoke alarm')).toBeTruthy();
    expect(screen.getByText('NAS degraded: disk 2 slow')).toBeTruthy();
  });

  test('at the minimum size (3x1) only the greeting and the next event are shown', () => {
    render(client.Tile, { props: tileProps({ size: { w: 3, h: 1 } }) });
    expect(screen.getByText('Good morning')).toBeTruthy();
    expect(screen.getByText('Team standup')).toBeTruthy();
    expect(screen.queryByText('Anna birthday')).toBeNull();
    expect(screen.queryByText('Smoke alarm')).toBeNull();
    expect(screen.queryByText('Rain expected around 10:00 AM')).toBeNull();
  });

  test('with every source missing the tile shows only the greeting and a quiet line', () => {
    render(client.Tile, { props: tileProps({ data: EMPTY }) });
    expect(screen.getByText('Hello')).toBeTruthy();
    expect(screen.getByText('Nothing else on the calendar today')).toBeTruthy();
    expect(screen.queryByText(/to do/)).toBeNull();
    expect(screen.queryByText(/Rain/)).toBeNull();
  });

  test('without data the tile says it is waiting', () => {
    render(client.Tile, { props: tileProps({ data: undefined, updatedAt: null }) });
    expect(screen.getByText('Waiting for your day…')).toBeTruthy();
  });

  test('a snapshot with an older rev than the one shown is ignored, a newer one applies', async () => {
    const { rerender } = render(client.Tile, { props: tileProps({ data: { ...EMPTY, rev: 5, pins: [{ title: 'Kept pin' }] } }) });
    expect(screen.getByText('Kept pin')).toBeTruthy();
    await rerender(tileProps({ data: { ...EMPTY, rev: 4, pins: [] } }));
    expect(screen.getByText('Kept pin')).toBeTruthy();
    await rerender(tileProps({ data: { ...EMPTY, rev: 6, pins: [] } }));
    expect(screen.queryByText('Kept pin')).toBeNull();
    await rerender(tileProps({ data: { ...EMPTY, epoch: 'boot-2', rev: 1, pins: [{ title: 'After restart' }] } }));
    expect(screen.getByText('After restart')).toBeTruthy(); // a new epoch wins even with a lower rev
  });

  test('times follow the locale and the time zone of the user', () => {
    render(client.Tile, { props: tileProps({ locale: 'de-DE', timeZone: 'Asia/Kolkata' }) });
    expect(screen.getByText('Donnerstag, 12. November')).toBeTruthy();
    expect(screen.getByText('Rain expected around 15:30')).toBeTruthy();
  });

  test('the tile renders no edit controls and no data-edit attribute', () => {
    const { container } = render(client.Tile, { props: tileProps() });
    expect(container.querySelector('[data-edit]')).toBeNull();
  });
});

describe('Detail', () => {
  test('detail lists today and tomorrow from the agenda, with all due todos and alerts', async () => {
    render(client.Detail, { props: detailProps() });
    await waitFor(() => expect(screen.getByText('Dentist')).toBeTruthy());
    expect(screen.getByText('All day thing')).toBeTruthy();
    expect(screen.getByText('All day')).toBeTruthy();
    expect(screen.getByText('Team standup')).toBeTruthy();
    expect(screen.getByText('Pay rent')).toBeTruthy();
    expect(screen.getByText('Milk')).toBeTruthy();
    expect(screen.getByText('Smoke alarm')).toBeTruthy();
    expect(screen.getByText('Critical')).toBeTruthy();
  });

  test('a rejected fetch shows an error line and keeps the snapshot content', async () => {
    const get = apiGet(() => Promise.reject(new DashError('internal', 'boom')));
    render(client.Detail, { props: detailProps({}, { get }) });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not load your agenda.'));
    expect(screen.getByText('Team standup')).toBeTruthy(); // the next event from the snapshot
    expect(screen.getByText('Pay rent')).toBeTruthy();
  });

  test('on a shared page the owner is not asked for the agenda', async () => {
    const get = apiGet(() => Promise.resolve(DAY));
    render(client.Detail, { props: detailProps({ isOwner: false }, { get }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(get).not.toHaveBeenCalled();
    expect(screen.getByText('Team standup')).toBeTruthy();
  });

  test('a new snapshot rev fetches the agenda again, an older answer is ignored', async () => {
    const get = apiGet(() => Promise.resolve(DAY));
    const { rerender } = render(client.Detail, { props: detailProps({}, { get }) });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await rerender(detailProps({ data: { ...fixture, rev: 4 } }, { get }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(get).toHaveBeenCalledWith('/day');
  });
});
