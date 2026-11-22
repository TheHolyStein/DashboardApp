import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { tick } from 'svelte';
import { dateFormatter } from '../client/format.js';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { runClientContractSuite } from '@dash/module-kit/client';
import { loadFixture } from '@dash/module-kit/testing';
import { DashError, type ModuleApi, type TileProps } from '@dash/contract';
import { identityT } from '@dash/ui';
import client from '../client/index.js';
import Face from './Face.svelte';
import { reactiveTheme } from './theme.svelte.js';
import UseNowProbe from './UseNowProbe.svelte';
import { settings as settingsSchema, type Settings, type Snapshot, type TimerList } from '../manifest.js';

const moduleDir = import.meta.dirname + '/..';
runClientContractSuite(client, { moduleDir, tileFixture: 'tile', detailFixture: 'detail' });

const START = '2026-01-01T12:00:00.000Z';
const fixture = loadFixture<Snapshot>(moduleDir, 'tile');
const EPOCH = fixture.epoch;
const settings: Settings = settingsSchema.parse({ timeZone: 'UTC' });

const timer = (id: string, label: string, secondsLeft: number) => ({
  id,
  label,
  endsAt: new Date(Date.parse(START) + secondsLeft * 1000).toISOString(),
  durationSec: 600,
});

function tileProps(over: Partial<TileProps<Snapshot, Settings>> = {}): TileProps<Snapshot, Settings> {
  return {
    data: { epoch: EPOCH, rev: 1, timers: [], nextEvent: null },
    updatedAt: START,
    stale: false,
    settings,
    level: 'edit',
    size: { w: 3, h: 2 },
    mode: 'day',
    api: {} as ModuleApi,
    t: identityT,
    locale: 'en',
    timeZone: 'UTC',
    isOwner: true,
    instanceId: 'i1',
    openDetail: () => undefined,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(START));
});
afterEach(() => {
  Reflect.deleteProperty(document, 'hidden');
  cleanup();
  vi.useRealTimers();
});

describe('Tile', () => {
  test('tile shows countdown "in 25 min" for nextEvent 25 minutes ahead', () => {
    const nextEvent = { title: 'Standup', start: new Date(Date.parse(START) + 25 * 60_000).toISOString() };
    render(client.Tile, { props: tileProps({ data: { epoch: EPOCH, rev: 1, timers: [], nextEvent } }) });
    expect(screen.getByText('in 25 min')).toBeTruthy();
    expect(screen.getByText('Standup')).toBeTruthy();
  });

  test('countdown wording: 1 min, hours, now, and hidden when showNextEvent is off', () => {
    const at = (min: number) => ({ title: 'E', start: new Date(Date.parse(START) + min * 60_000).toISOString() });
    for (const [min, text] of [[1, 'in 1 min'], [120, 'in 2 h'], [60, 'in 1 h'], [-1, 'now']] as const) {
      const { unmount } = render(client.Tile, { props: tileProps({ data: { epoch: EPOCH, rev: 1, timers: [], nextEvent: at(min) } }) });
      expect(screen.getByText(text)).toBeTruthy();
      unmount();
    }
    render(client.Tile, {
      props: tileProps({ data: { epoch: EPOCH, rev: 1, timers: [], nextEvent: at(25) }, settings: { ...settings, showNextEvent: false } }),
    });
    expect(screen.queryByText('in 25 min')).toBeNull();
  });

  test('without a theme the built-in digital time shows, in the chosen zone', () => {
    render(client.Tile, { props: tileProps({ settings: { ...settings, timeZone: 'Asia/Tokyo' } }) });
    expect(screen.getByText('21:00')).toBeTruthy(); // 12:00 UTC is 21:00 in Tokyo
  });

  test('an empty zone setting formats with the user locale and time zone from the props', () => {
    const { container } = render(client.Tile, { props: tileProps({ locale: 'de-DE', timeZone: 'Asia/Kolkata', settings: { ...settings, timeZone: '' } }) });
    expect(container.querySelector('time')?.textContent).toBe('17:30'); // 12:00 UTC is 17:30 in India
    expect(container.querySelector('.date')?.textContent).toMatch(/^Do\.?,? 1\. Jan/); // German weekday and day order
  });

  test('timer labels, the tile label and the event title are marked as user content', () => {
    const nextEvent = { title: 'Standup', start: new Date(Date.parse(START) + 25 * 60_000).toISOString() };
    const { container } = render(client.Tile, {
      props: tileProps({ data: { epoch: EPOCH, rev: 1, timers: [timer('a', 'Tea', 60)], nextEvent }, settings: { ...settings, label: 'Home' } }),
    });
    const user = [...container.querySelectorAll('[data-user]')].map((e) => e.textContent);
    expect(user.sort()).toEqual(['Home', 'Standup', 'Tea']);
  });

  test('unknown face id falls back to theme default', async () => {
    const clockFace = vi.fn((id?: string) => (id === 'nope' ? Promise.reject(new Error('no such face')) : Promise.resolve(Face)));
    render(client.Tile, {
      props: tileProps({ settings: { ...settings, face: 'nope', showSeconds: true, label: 'Home' } }),
      context: new Map([['dash:theme', { clockFace }]]),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(clockFace.mock.calls.map((c) => c[0])).toEqual(['nope', undefined]);
    const face = screen.getByTestId('face');
    expect(face.dataset['seconds']).toBe('true');
    expect(face.dataset['label']).toBe('Home');
    expect(face.textContent).toContain('UTC');
  });

  test('an empty face setting asks the theme for its default and a failing theme falls back to built-in', async () => {
    const clockFace = vi.fn(() => Promise.reject(new Error('broken')));
    render(client.Tile, { props: tileProps(), context: new Map([['dash:theme', { clockFace }]]) });
    await vi.advanceTimersByTimeAsync(0);
    expect(clockFace.mock.calls).toEqual([[undefined]]);
    expect(screen.getByText('12:00')).toBeTruthy();
  });

  test('the tile has no interactive content: the shell frame opens the detail pane', () => {
    const { container } = render(client.Tile, {
      props: tileProps({ data: { epoch: EPOCH, rev: 1, timers: [timer('a', 'Tea', 60)], nextEvent: fixture.nextEvent } }),
    });
    expect(container.querySelector('button, a, input, select, textarea, [tabindex], [role=button]')).toBeNull();
  });

  test('the time is exposed once as text on the built-in path, and the date once', () => {
    render(client.Tile, { props: tileProps() });
    expect(screen.getAllByText('12:00')).toHaveLength(1);
    expect(screen.getAllByText(/Thu/)).toHaveLength(1);
    expect(document.querySelector('[aria-live]')).toBeNull(); // visible text, not a live region
  });

  test('while the theme face loads the readout holds the space and is still the only time text', async () => {
    let release: (c: typeof Face) => void = () => undefined;
    const clockFace = vi.fn(() => new Promise<typeof Face>((resolve) => (release = resolve)));
    const { container } = render(client.Tile, { props: tileProps(), context: new Map([['dash:theme', { clockFace }]]) });
    expect(screen.getAllByText('12:00')).toHaveLength(1);
    expect(container.querySelector('.face')?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelector('.fallback.pending')).toBeTruthy();
    release(Face);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByText('12:00')).toBeNull(); // the face took over; it exposes the time itself
    expect(screen.getByTestId('face')).toBeTruthy();
    expect(container.querySelector('.face')?.getAttribute('aria-busy')).toBe('false');
  });

  test('the face is resolved again when the theme id changes', async () => {
    const theme = reactiveTheme(vi.fn(() => Promise.resolve(Face)));
    render(client.Tile, { props: tileProps(), context: new Map([['dash:theme', theme]]) });
    await vi.advanceTimersByTimeAsync(0);
    expect(theme.clockFace).toHaveBeenCalledTimes(1);
    theme.id = 'two';
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(theme.clockFace).toHaveBeenCalledTimes(2);
  });

  test('an unknown stored time zone renders in UTC instead of crashing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(client.Tile, { props: tileProps({ settings: { ...settings, timeZone: 'Mars/Base' } }) });
    expect(screen.getByText('12:00')).toBeTruthy();
    warn.mockRestore();
  });

  test('formatters are cached per locale and options', () => {
    expect(dateFormatter({ timeZone: 'UTC' }, 'en')).toBe(dateFormatter({ timeZone: 'UTC' }, 'en'));
    expect(dateFormatter({ timeZone: 'UTC' }, 'en')).not.toBe(dateFormatter({ timeZone: 'UTC' }, 'de'));
  });

  test('a snapshot with an older rev than the one shown is ignored by the tile, a newer one applies', async () => {
    const { rerender } = render(client.Tile, { props: tileProps({ data: { epoch: EPOCH, rev: 5, timers: [timer('a', 'Tea', 60)], nextEvent: null } }) });
    expect(screen.getByText('Tea')).toBeTruthy();
    await rerender(tileProps({ data: { epoch: EPOCH, rev: 4, timers: [], nextEvent: null } }));
    expect(screen.getByText('Tea')).toBeTruthy();
    await rerender(tileProps({ data: { epoch: EPOCH, rev: 6, timers: [], nextEvent: null } }));
    expect(screen.queryByText('Tea')).toBeNull();
  });

  test('"+1" is shown with three timers and only two are listed', () => {
    const timers = [timer('a', 'Tea', 60), timer('b', 'Eggs', 120), timer('c', 'Bread', 180)];
    render(client.Tile, { props: tileProps({ data: { epoch: EPOCH, rev: 1, timers, nextEvent: null } }) });
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('Tea')).toBeTruthy();
    expect(screen.getByText('Eggs')).toBeTruthy();
    expect(screen.queryByText('Bread')).toBeNull();
  });

  test('at the minimum size (2x1) only the face is shown', () => {
    const timers = [timer('a', 'Tea', 60)];
    render(client.Tile, { props: tileProps({ size: { w: 2, h: 1 }, data: { epoch: EPOCH, rev: 1, timers, nextEvent: fixture.nextEvent } }) });
    expect(screen.queryByText('Tea')).toBeNull();
    expect(screen.queryByText('Team standup')).toBeNull();
    expect(screen.getByText('12:00')).toBeTruthy();
  });

  test('ticks per second while a timer is running even if showSeconds is false', async () => {
    const timers = [timer('a', 'Tea', 90)];
    render(client.Tile, { props: tileProps({ data: { epoch: EPOCH, rev: 1, timers, nextEvent: null } }) });
    expect(screen.getByText('1:30')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(1000);
    expect(screen.getByText('1:29')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(1000);
    expect(screen.getByText('1:28')).toBeTruthy();
  });

  test('with no timer and showSeconds off the tile re-renders only once a minute', async () => {
    render(client.Tile, { props: tileProps() });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(screen.getByText('12:00')).toBeTruthy();
    await vi.advanceTimersByTimeAsync(1000);
    expect(screen.getByText('12:01')).toBeTruthy();
  });
});

describe('useNow', () => {
  const hide = (hidden: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const shown = () => screen.getByRole('status').textContent;

  test('useNow does not tick per second when showSeconds is false', async () => {
    render(UseNowProbe, { props: { seconds: false } });
    expect(vi.getTimerCount()).toBe(1);
    const first = shown();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(shown()).toBe(first);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(shown()).toBe('2026-01-01T12:01:00.000Z');
  });

  test('ticks every second when seconds are on', async () => {
    render(UseNowProbe, { props: { seconds: true } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(shown()).toBe('2026-01-01T12:00:01.000Z');
    await vi.advanceTimersByTimeAsync(2000);
    expect(shown()).toBe('2026-01-01T12:00:03.000Z');
  });

  test('switches rate when seconds changes', async () => {
    const { rerender } = render(UseNowProbe, { props: { seconds: false } });
    await rerender({ seconds: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(shown()).toBe('2026-01-01T12:00:01.000Z');
  });

  test('useNow pauses while hidden and re-syncs when visible again', async () => {
    try {
      render(UseNowProbe, { props: { seconds: true } });
      expect(vi.getTimerCount()).toBe(1);
      hide(true);
      expect(vi.getTimerCount()).toBe(0);
      vi.setSystemTime(new Date('2026-01-01T12:10:00.000Z')); // time passes while hidden, nothing ticks
      await vi.advanceTimersByTimeAsync(5000);
      expect(shown()).toBe('2026-01-01T12:00:00.000Z');
      hide(false);
      await tick();
      expect(shown()).toBe('2026-01-01T12:10:05.000Z');
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      Reflect.deleteProperty(document, 'hidden');
    }
  });

  test('cleans up its timer on destroy', () => {
    const { unmount } = render(UseNowProbe, { props: { seconds: true } });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Detail', () => {
  const detailData = loadFixture<Snapshot>(moduleDir, 'detail');
  const detailList = { epoch: EPOCH, rev: detailData.rev, timers: detailData.timers };
  const ZONES = ['Europe/Berlin', 'America/New_York', 'Asia/Tokyo']; // GET /zones, not part of a snapshot
  const emptyApi = (over: Partial<ModuleApi> = {}): ModuleApi =>
    ({
      get: vi.fn((path: string) => Promise.resolve(path === '/zones' ? ZONES : detailList)),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn((path: string) =>
        Promise.resolve({ epoch: EPOCH, rev: detailData.rev + 1, timers: detailData.timers.filter((x) => path !== `/timers/${x.id}`) }),
      ),
      ...over,
    }) as unknown as ModuleApi;
  const props = (over: Record<string, unknown> = {}) => ({
    data: detailData,
    updatedAt: START,
    stale: false,
    settings,
    level: 'edit' as const,
    mode: 'day' as const,
    api: emptyApi(),
    t: identityT,
    locale: 'en',
    timeZone: 'UTC',
    isOwner: true,
    instanceId: 'i1',
    params: {},
    close: () => undefined,
    ...over,
  });

  test('detail hides create/cancel/zone edit at level view', async () => {
    const { container, unmount } = render(client.Detail, { props: props({ level: 'edit' }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelectorAll('[data-edit]').length).toBeGreaterThan(5);
    expect(screen.getAllByRole('button', { name: /^Remove / }).length).toBe(3);
    expect(screen.getAllByRole('button', { name: /^Cancel / }).length).toBe(2);
    unmount();

    const view = render(client.Detail, { props: props({ level: 'view' }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(view.container.querySelector('[data-edit]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove|Cancel|Start timer|Add/ })).toBeNull();
    expect(screen.getByText('Europe/Berlin')).toBeTruthy(); // still listed
    expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy(); // stopwatch is local, always available
  });

  test('creating a timer posts label and duration, cancelling deletes', async () => {
    const created = { id: 'new', label: 'Tea', endsAt: new Date(Date.parse(START) + 90_000).toISOString(), durationSec: 90 };
    const post = vi.fn(() => Promise.resolve({ epoch: EPOCH, rev: 6, timers: [...detailData.timers, created] }));
    const del = vi.fn(() => Promise.resolve({ epoch: EPOCH, rev: 7, timers: detailData.timers }));
    const api = emptyApi({ post: post as ModuleApi['post'], delete: del as ModuleApi['delete'] });
    const { container } = render(client.Detail, { props: props({ api }) });
    await vi.advanceTimersByTimeAsync(0);

    await fireEvent.input(container.querySelector('input[name=label]')!, { target: { value: ' Tea ' } });
    await fireEvent.input(container.querySelector('input[name=minutes]')!, { target: { value: '1' } });
    await fireEvent.input(container.querySelector('input[name=seconds]')!, { target: { value: '30' } });
    await fireEvent.submit(container.querySelector('form')!);
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledWith('/timers', { label: 'Tea', durationSec: 90 });
    expect(screen.getByText('1:30')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel Tea' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(del).toHaveBeenCalledWith('/timers/new');
    expect(screen.queryByRole('button', { name: 'Cancel Tea' })).toBeNull();
  });

  test('a zero duration is refused without calling the server', async () => {
    const post = vi.fn();
    const api = emptyApi({ post: post as ModuleApi['post'] });
    const { container } = render(client.Detail, { props: props({ api }) });
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.input(container.querySelector('input[name=minutes]')!, { target: { value: '0' } });
    await fireEvent.input(container.querySelector('input[name=seconds]')!, { target: { value: '0' } });
    await fireEvent.submit(container.querySelector('form')!);
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('duration');
  });

  test('adding and removing a zone saves the whole list with PUT', async () => {
    const put = vi.fn((_p: string, body: unknown) => Promise.resolve((body as { zones: string[] }).zones));
    const api = emptyApi({ put: put as ModuleApi['put'] });
    const { container } = render(client.Detail, { props: props({ api }) });
    await vi.advanceTimersByTimeAsync(0);

    await fireEvent.change(container.querySelector('select')!, { target: { value: 'UTC' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenLastCalledWith('/zones', { zones: [...ZONES, 'UTC'] });

    await fireEvent.click(screen.getByRole('button', { name: 'Remove Asia/Tokyo' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(put).toHaveBeenLastCalledWith('/zones', { zones: ['Europe/Berlin', 'America/New_York', 'UTC'] });
  });

  test('a double click on Cancel sends one request and the button is busy meanwhile', async () => {
    let finish: () => void = () => undefined;
    const del = vi.fn(
      () => new Promise<TimerList>((resolve) => (finish = () => resolve({ epoch: EPOCH, rev: 6, timers: detailData.timers.slice(1) }))),
    );
    render(client.Detail, { props: props({ api: emptyApi({ delete: del as ModuleApi['delete'] }) }) });
    await vi.advanceTimersByTimeAsync(0);
    const button = screen.getByRole('button', { name: 'Cancel Pasta' });
    await fireEvent.click(button);
    await fireEvent.click(button);
    expect(del).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-busy')).toBe('true');
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByRole('button', { name: 'Cancel Pasta' })).toBeNull();
  });

  test('a double submit creates one timer', async () => {
    let finish: (v: unknown) => void = () => undefined;
    const post = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const { container } = render(client.Detail, { props: props({ api: emptyApi({ post: post as ModuleApi['post'] }) }) });
    await vi.advanceTimersByTimeAsync(0);
    const form = container.querySelector('form')!;
    await fireEvent.submit(form);
    await fireEvent.submit(form);
    expect(post).toHaveBeenCalledTimes(1);
    finish({ epoch: EPOCH, rev: 6, timers: [] });
    await vi.advanceTimersByTimeAsync(0);
  });

  test('two quick zone edits both apply, in order', async () => {
    const calls: string[][] = [];
    const put = vi.fn(
      (_p: string, body: unknown) =>
        new Promise<string[]>((resolve) => {
          const zones = (body as { zones: string[] }).zones;
          calls.push(zones);
          setTimeout(() => resolve(zones), 50);
        }),
    );
    const { container } = render(client.Detail, { props: props({ api: emptyApi({ put: put as ModuleApi['put'] }) }) });
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.change(container.querySelector('select')!, { target: { value: 'UTC' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Remove Asia/Tokyo' })); // before the add has answered
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toEqual([[...ZONES, 'UTC'], ['Europe/Berlin', 'America/New_York', 'UTC']]);
    expect(screen.queryByRole('button', { name: 'Remove Asia/Tokyo' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove UTC' })).toBeTruthy();
  });

  test('a failed zone save followed by another edit still applies the second edit', async () => {
    const calls: string[][] = [];
    const put = vi.fn((_p: string, body: unknown) => {
      const zones = (body as { zones: string[] }).zones;
      calls.push(zones);
      return calls.length === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(zones);
    });
    const { container } = render(client.Detail, { props: props({ api: emptyApi({ put: put as ModuleApi['put'] }) }) });
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.change(container.querySelector('select')!, { target: { value: 'UTC' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByRole('alert').textContent).toContain('Could not save');
    await fireEvent.click(screen.getByRole('button', { name: 'Remove Asia/Tokyo' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([[...ZONES, 'UTC'], ['Europe/Berlin', 'America/New_York']]); // the failed add left no trace
    expect(screen.queryByRole('button', { name: 'Remove Asia/Tokyo' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('the zone list shows a loading state until GET /zones answers, then the list', async () => {
    let answer: (list: string[]) => void = () => undefined;
    const get = vi.fn((path: string) => (path === '/zones' ? new Promise<string[]>((r) => (answer = r)) : Promise.resolve(detailList)));
    render(client.Detail, { props: props({ api: emptyApi({ get: get as ModuleApi['get'] }) }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByText('No world clocks yet.')).toBeNull();
    expect(screen.getByText('Loading…')).toBeTruthy();
    answer([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByText('No world clocks yet.')).toBeTruthy();
  });

  test('world clocks use the user locale; timer labels are user content', async () => {
    const get = vi.fn((path: string) => Promise.resolve(path === '/zones' ? ['Asia/Kolkata'] : detailList));
    const { container } = render(client.Detail, { props: props({ locale: 'de-DE', timeZone: 'Asia/Kolkata', api: emptyApi({ get: get as ModuleApi['get'] }) }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector('.zones time')?.textContent).toBe('17:30');
    expect(container.querySelectorAll('.name [data-user]').length).toBeGreaterThan(0);
  });

  describe('ordering by rev', () => {
    const created = { id: 'new', label: 'Tea', endsAt: new Date(Date.parse(START) + 90_000).toISOString(), durationSec: 90 };
    const withTea = (rev: number) => ({ epoch: EPOCH, rev, timers: [...detailData.timers, created] });
    const defer = <T,>() => {
      let resolve: (v: T) => void = () => undefined;
      const promise = new Promise<T>((r) => (resolve = r));
      return { promise, resolve };
    };
    const submit = async (container: HTMLElement) => {
      await fireEvent.submit(container.querySelector('form')!);
      await vi.advanceTimersByTimeAsync(0);
    };

    test('a GET that resolves after a POST response with an older rev does not drop the new timer', async () => {
      const lateGet = defer<TimerList>();
      let timersGets = 0;
      const get = vi.fn((path: string) => (path === '/zones' ? Promise.resolve(ZONES) : ++timersGets === 1 ? lateGet.promise : Promise.resolve(detailList)));
      const post = vi.fn(() => Promise.resolve(withTea(6)));
      const api = emptyApi({ get: get as ModuleApi['get'], post: post as ModuleApi['post'] });
      const { container } = render(client.Detail, { props: props({ api }) });
      await vi.advanceTimersByTimeAsync(0);
      await submit(container);
      expect(screen.getByRole('button', { name: 'Cancel Tea' })).toBeTruthy();
      lateGet.resolve({ epoch: EPOCH, rev: detailData.rev, timers: detailData.timers }); // issued before the POST, answered after it
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByRole('button', { name: 'Cancel Tea' })).toBeTruthy();
    });

    test('a GET that resolves after a DELETE response does not bring the timer back', async () => {
      const lateGet = defer<TimerList>();
      const get = vi.fn((path: string) => (path === '/zones' ? Promise.resolve(ZONES) : lateGet.promise));
      const api = emptyApi({ get: get as ModuleApi['get'] });
      // The pane opens from a snapshot at rev 5; its own GET is still in flight.
      render(client.Detail, { props: props({ api }) });
      await vi.advanceTimersByTimeAsync(0);
      await fireEvent.click(screen.getByRole('button', { name: 'Cancel Pasta' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.queryByRole('button', { name: 'Cancel Pasta' })).toBeNull();
      lateGet.resolve(detailList); // rev 5: older than the DELETE response (rev 6)
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.queryByRole('button', { name: 'Cancel Pasta' })).toBeNull();
    });

    test('two overlapping GETs resolving out of order keep the newer list', async () => {
      const first = defer<TimerList>();
      const second = defer<TimerList>();
      let timersGets = 0;
      const get = vi.fn((path: string) => (path === '/zones' ? Promise.resolve(ZONES) : ++timersGets === 1 ? first.promise : second.promise));
      const api = emptyApi({ get: get as ModuleApi['get'] });
      render(client.Detail, { props: props({ api }) });
      await vi.advanceTimersByTimeAsync(0);
      document.dispatchEvent(new Event('visibilitychange')); // the pane reads again when it becomes visible: a second GET in flight
      await vi.advanceTimersByTimeAsync(0);
      expect(timersGets).toBe(2);
      second.resolve(withTea(9));
      await vi.advanceTimersByTimeAsync(0);
      first.resolve({ epoch: EPOCH, rev: 8, timers: detailData.timers });
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByRole('button', { name: 'Cancel Tea' })).toBeTruthy();
    });

    test('a snapshot push with an older rev is ignored by the pane, a newer one applies', async () => {
      const { rerender } = render(client.Detail, { props: props({ data: { ...detailData, rev: 7, timers: detailData.timers.slice(0, 1) } }) });
      await vi.advanceTimersByTimeAsync(0);
      // the open-time GET answers rev 5, older than the pushed rev 7: ignored
      expect(screen.queryByRole('button', { name: 'Cancel Laundry' })).toBeNull();
      await rerender(props({ data: { ...detailData, rev: 6 } })); // older push
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.queryByRole('button', { name: 'Cancel Laundry' })).toBeNull();
      await rerender(props({ data: { ...detailData, rev: 8 } })); // newer push
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByRole('button', { name: 'Cancel Laundry' })).toBeTruthy();
    });

    test('a failed GET shows an error line', async () => {
      const get = vi.fn((path: string) => (path === '/zones' ? Promise.resolve(ZONES) : Promise.reject(new Error('offline'))));
      render(client.Detail, { props: props({ api: emptyApi({ get: get as ModuleApi['get'] }) }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByRole('alert').textContent).toContain('Could not load');
    });
  });


  describe('epoch (server restart)', () => {
    const NEW = 'boot-2';
    test('a lower rev with a new epoch replaces the list; the same epoch with a lower rev is ignored', async () => {
      const { rerender } = render(client.Detail, { props: props({ data: { ...detailData, rev: 9 } }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByRole('button', { name: 'Cancel Laundry' })).toBeTruthy();
      await rerender(props({ data: { ...detailData, rev: 3, timers: detailData.timers.slice(0, 1) } })); // same epoch, older
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.getByRole('button', { name: 'Cancel Laundry' })).toBeTruthy();
      await rerender(props({ data: { ...detailData, epoch: NEW, rev: 1, timers: detailData.timers.slice(0, 1) } })); // restart
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.queryByRole('button', { name: 'Cancel Laundry' })).toBeNull();
    });

    test('a list answer from a new epoch with a lower rev is applied', async () => {
      const get = vi.fn((path: string) =>
        Promise.resolve(path === '/zones' ? ZONES : { epoch: NEW, rev: 0, timers: detailData.timers.slice(0, 1) }),
      );
      render(client.Detail, { props: props({ api: emptyApi({ get: get as ModuleApi['get'] }) }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.queryByRole('button', { name: 'Cancel Laundry' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Cancel Pasta' })).toBeTruthy();
    });

    test('the tile takes a snapshot of a new epoch with a lower rev, and ignores an older rev of the same epoch', async () => {
      const { rerender } = render(client.Tile, { props: tileProps({ data: { epoch: EPOCH, rev: 5, timers: [timer('a', 'Tea', 60)], nextEvent: null } }) });
      await rerender(tileProps({ data: { epoch: EPOCH, rev: 4, timers: [], nextEvent: null } }));
      expect(screen.getByText('Tea')).toBeTruthy();
      await rerender(tileProps({ data: { epoch: NEW, rev: 1, timers: [], nextEvent: null } }));
      expect(screen.queryByText('Tea')).toBeNull();
    });
  });

  describe('shared page (not the owner)', () => {
    test('shows the owner\'s snapshot read-only and calls no route', async () => {
      const get = vi.fn();
      const post = vi.fn();
      const put = vi.fn();
      const api = emptyApi({ get, post, put });
      const { container } = render(client.Detail, { props: props({ isOwner: false, api }) });
      await vi.advanceTimersByTimeAsync(0);
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(put).not.toHaveBeenCalled();
      expect(container.querySelector('[data-edit]')).toBeNull();
      expect(screen.queryByRole('button', { name: /Remove|Cancel|Start timer|Add/ })).toBeNull();
      expect(screen.getByText('Pasta')).toBeTruthy(); // the owner's timers
      expect(screen.getByText('World clocks are personal to each user.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Start' })).toBeTruthy(); // stopwatch is local
    });

    test('a pushed snapshot still updates the list', async () => {
      const get = vi.fn();
      const api = emptyApi({ get });
      const { rerender } = render(client.Detail, { props: props({ isOwner: false, api }) });
      await vi.advanceTimersByTimeAsync(0);
      await rerender(props({ isOwner: false, api, data: { ...detailData, rev: detailData.rev + 1, timers: detailData.timers.slice(0, 1) } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(screen.queryByText('Laundry')).toBeNull();
      expect(get).not.toHaveBeenCalled();
    });
  });

  test('focus moves to the list heading after removing a zone or cancelling a timer', async () => {
    const put = vi.fn((_p: string, body: unknown) => Promise.resolve((body as { zones: string[] }).zones));
    render(client.Detail, { props: props({ api: emptyApi({ put: put as ModuleApi['put'] }) }) });
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(screen.getByRole('button', { name: 'Remove Asia/Tokyo' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'World clocks' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel Pasta' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Timers' }));
  });

  test('the server message for an invalid zone is shown instead of a generic one', async () => {
    const put = vi.fn(() => Promise.reject(new DashError('invalid', 'unknown time zone: Mars/Base')));
    const { container } = render(client.Detail, { props: props({ api: emptyApi({ put }) }) });
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.change(container.querySelector('select')!, { target: { value: 'UTC' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByRole('alert').textContent).toBe('unknown time zone: Mars/Base');
  });

  test('a saved zone the runtime does not know renders in UTC instead of crashing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const api = emptyApi({ get: vi.fn((path: string) => Promise.resolve(path === '/zones' ? ['Mars/Base'] : detailList)) as ModuleApi['get'] });
    render(client.Detail, { props: props({ api, data: { epoch: EPOCH, rev: 1, timers: [], nextEvent: null } }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('Mars/Base')).toBeTruthy();
    expect(screen.getByText('12:00')).toBeTruthy();
    warn.mockRestore();
  });

  test('the stopwatch interval pauses while the document is hidden and resyncs when visible', async () => {
    let ms = 0;
    render(client.Detail, { props: props({ clock: () => ms }) });
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    const running = vi.getTimerCount(); // useNow's timeout + the stopwatch interval
    const hide = (hidden: boolean) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    try {
      hide(true);
      expect(vi.getTimerCount()).toBe(running - 2); // both stop while hidden
      ms = 5000;
      hide(false);
      await tick();
      expect(vi.getTimerCount()).toBe(running);
      expect(screen.getByText('0:05.00')).toBeTruthy();
    } finally {
      Reflect.deleteProperty(document, 'hidden');
    }
  });

  test('stopwatch lap and reset with the injected clock', async () => {
    let ms = 1000;
    render(client.Detail, { props: props({ clock: () => ms }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('0:00.00')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    ms += 1500;
    await vi.advanceTimersByTimeAsync(100);
    expect(screen.getByText('0:01.50')).toBeTruthy();

    await fireEvent.click(screen.getByRole('button', { name: 'Lap' }));
    ms += 2250;
    await fireEvent.click(screen.getByRole('button', { name: 'Lap' }));
    await vi.advanceTimersByTimeAsync(100);
    const laps = [...document.querySelectorAll('ol li')].map((li) => li.textContent?.trim());
    expect(laps).toEqual(['0:01.50', '0:02.25']);

    await fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByText('0:03.75')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByText('0:00.00')).toBeTruthy();
    expect(document.querySelectorAll('ol li').length).toBe(0);
  });

  test('a failed load shows an error instead of throwing', async () => {
    const api = emptyApi({ get: vi.fn(() => Promise.reject(new Error('offline'))) });
    render(client.Detail, { props: props({ api }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByRole('alert').textContent).toContain('Could not load');
  });
});
