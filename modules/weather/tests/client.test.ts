import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount, type Component, type ComponentProps } from 'svelte';
import { runClientContractSuite } from '@dash/module-kit/client';
import { loadFixture } from '@dash/module-kit/testing';
import type { DetailProps, ModuleApi, SettingsProps, TileProps } from '@dash/contract';
import { identityT } from '@dash/ui';
import client from '../client/index.js';
import { settings as settingsSchema, type DetailData, type Forecast, type Settings, type Snapshot } from '../manifest.js';

const moduleDir = import.meta.dirname + '/..';
runClientContractSuite(client, { moduleDir, tileFixture: 'tile' });

const forecast = loadFixture<Forecast>(moduleDir, 'tile');
const detailFixture = loadFixture<DetailData>(moduleDir, 'detail');
const defaults: Settings = settingsSchema.parse({});

const mounted: Array<() => void> = [];
afterEach(() => {
  for (const u of mounted.splice(0)) u();
  document.body.replaceChildren();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the client's components are generic over their data
function render<C extends Component<any>>(component: C, props: ComponentProps<C>): HTMLElement {
  const target = document.createElement('div');
  document.body.append(target);
  const instance = mount(component as Component<Record<string, unknown>>, { target, props: props as Record<string, unknown> });
  mounted.push(() => void unmount(instance));
  flushSync();
  return target;
}

const rejectingApi: ModuleApi = {
  get: () => Promise.reject(new Error('offline')),
  post: () => Promise.reject(new Error('offline')),
  put: () => Promise.reject(new Error('offline')),
  patch: () => Promise.reject(new Error('offline')),
  delete: () => Promise.reject(new Error('offline')),
};

const tileProps = (over: Partial<TileProps<Snapshot, Settings>> = {}): TileProps<Snapshot, Settings> => ({
  data: forecast,
  updatedAt: '2026-01-01T12:00:00.000Z',
  stale: false,
  settings: defaults,
  level: 'edit',
  size: { w: 3, h: 2 },
  mode: 'day',
  api: rejectingApi,
  t: identityT,
  locale: 'en',
  timeZone: 'UTC',
  isOwner: true,
  openDetail: () => undefined,
  ...over,
});

const detailProps = (api: ModuleApi, over: Partial<DetailProps<Snapshot, Settings>> = {}): DetailProps<Snapshot, Settings> => ({
  data: forecast,
  updatedAt: '2026-01-01T12:00:00.000Z',
  stale: false,
  settings: defaults,
  level: 'view',
  mode: 'day',
  api,
  t: identityT,
  locale: 'en',
  timeZone: 'UTC',
  isOwner: false,
  params: {},
  close: () => undefined,
  ...over,
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await tick();
};

describe('Tile', () => {
  it('needsSetup tile shows setup hint', () => {
    const el = render(client.Tile, tileProps({ data: { needsSetup: true } }));
    expect(el.textContent).toContain('Open settings to set up');
    const viewer = render(client.Tile, tileProps({ data: { needsSetup: true }, level: 'view' }));
    expect(viewer.textContent).toContain('Not set up yet');
    expect(viewer.textContent).not.toContain('Open settings');
    const guest = render(client.Tile, tileProps({ data: { needsSetup: true }, isOwner: false }));
    expect(guest.textContent).toContain('Not set up yet');
  });

  it('imperial units convert 20 °C to 68 °F', () => {
    const metric = render(client.Tile, tileProps({ size: { w: 2, h: 1 } }));
    expect(metric.querySelector('.temp')?.textContent).toBe('20°C');
    const imperial = render(client.Tile, tileProps({ data: { ...forecast, units: 'imperial' }, size: { w: 2, h: 1 } }));
    expect(imperial.querySelector('.temp')?.textContent).toBe('68°F');
    // Other values convert too: 22.4 °C is 72.32 °F; 0.6 mm is 0.02 in.
    const full = render(client.Tile, tileProps({ data: { ...forecast, units: 'imperial' } }));
    expect(full.textContent).toContain('72°F');
    expect(full.textContent).toContain('0.02 in');
  });

  it('pollen section hidden when show.pollen false', () => {
    const shown = render(client.Tile, tileProps());
    expect(shown.textContent).toContain('Pollen: Grass, High');
    const hidden = render(client.Tile, tileProps({ settings: { ...defaults, show: { ...defaults.show, pollen: false } } }));
    expect(hidden.textContent).not.toContain('Pollen');
    expect(hidden.textContent).toContain('Air: Fair');
    const noAir = render(client.Tile, tileProps({ settings: { ...defaults, show: { ...defaults.show, air: false } } }));
    expect(noAir.textContent).not.toContain('Air:');
  });

  it('shows only temperature and icon at the minimum size, more from two rows up', () => {
    const small = render(client.Tile, tileProps({ size: { w: 2, h: 1 } }));
    expect(small.querySelector('.temp')).not.toBeNull();
    expect(small.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBe('Rain');
    expect(small.querySelector('.place, .range, .rain, .chips')).toBeNull();
    const roomy = render(client.Tile, tileProps());
    expect(roomy.querySelector('.place')?.textContent).toBe('Berlin');
    expect(roomy.querySelector('.range')?.textContent?.replace(/\s+/g, ' ')).toContain('High 22°C');
    expect(roomy.querySelector('.rain')?.textContent).toContain('Rain from 3:00 PM');
  });

  it('says so when no rain is coming', () => {
    const el = render(client.Tile, tileProps({ data: { ...forecast, nextPrecip: null } }));
    expect(el.querySelector('.rain')?.textContent).toBe('No rain in the next 24 h');
  });

  it('formats times in the user time zone', () => {
    const el = render(client.Tile, tileProps({ timeZone: 'Asia/Kolkata' }));
    expect(el.querySelector('.rain')?.textContent).toContain('8:30 PM'); // 15:00Z
  });
});

describe('Detail', () => {
  const okApi = (): { api: ModuleApi; get: ReturnType<typeof vi.fn> } => {
    const get = vi.fn(() => Promise.resolve(detailFixture));
    return { api: { ...rejectingApi, get: get as unknown as ModuleApi['get'] }, get };
  };

  it('asks for the instance detail and renders days, pollen per type and air components', async () => {
    const { api, get } = okApi();
    const el = render(client.Detail, detailProps(api));
    await settle();
    expect(get).toHaveBeenCalledWith('/detail', { instanceId: forecast.instanceId });
    expect(el.querySelectorAll('.days li')).toHaveLength(3);
    const rows = [...el.querySelectorAll('.pollen tbody tr')];
    expect(rows.map((r) => r.querySelector('th')?.textContent)).toEqual(['Birch', 'Grass']);
    const labels = [...(rows[1]?.querySelectorAll('[role="img"]') ?? [])].map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Grass: High', 'Grass: Very high', 'Grass: None']);
    expect(rows[0]?.querySelectorAll('.seg.on')).toHaveLength(5); // birch: levels 2, 3 and no data
    expect(el.textContent).toContain('PM2.5');
    expect(el.textContent).not.toContain('SO₂'); // null component left out
    expect(el.textContent).toContain('34');
    expect(el.textContent).toContain('Sunrise');
  });

  it('pollen section hidden when show.pollen false (detail too)', async () => {
    const { api } = okApi();
    const el = render(client.Detail, detailProps(api, { settings: { ...defaults, show: { ...defaults.show, pollen: false, air: false, uv: false } } }));
    await settle();
    expect(el.querySelector('.pollen')).toBeNull();
    expect(el.textContent).not.toContain('Pollen');
    expect(el.textContent).not.toContain('Air quality');
    expect(el.textContent).not.toContain('UV');
  });

  it('shows the current conditions without the route, and an error line when it fails', async () => {
    const el = render(client.Detail, detailProps(rejectingApi));
    await settle();
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('Could not load the forecast details.');
    expect(el.textContent).toContain('20°C');
    expect(el.querySelector('.days')).toBeNull();
  });

  it('converts to imperial', async () => {
    const { api } = okApi();
    const el = render(client.Detail, detailProps(api, { data: { ...forecast, units: 'imperial' } }));
    await settle();
    expect(el.querySelector('.big')?.textContent).toContain('68°F');
    expect(el.querySelector('.days li')?.textContent).toContain('72°F');
  });

  it('does not ask the server without an instance (not set up)', async () => {
    const { api, get } = okApi();
    const el = render(client.Detail, detailProps(api, { data: { needsSetup: true } }));
    await settle();
    expect(get).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Not set up yet');
  });
});

describe('Settings', () => {
  const place = { name: 'Berlin', lat: 52.52437, lon: 13.41053, detail: 'State of Berlin, Germany' };
  const props = (api: ModuleApi, over: Partial<SettingsProps<Settings>> = {}): SettingsProps<Settings> => ({
    value: defaults,
    onChange: () => undefined,
    api,
    t: identityT,
    locale: 'en',
    timeZone: 'UTC',
    isOwner: true,
    ...over,
  });

  it('searches places through /geocode and stores the chosen one', async () => {
    const get = vi.fn(() => Promise.resolve([place]));
    const onChange = vi.fn();
    const el = render(client.Settings as NonNullable<typeof client.Settings>, props({ ...rejectingApi, get: get as unknown as ModuleApi['get'] }, { onChange }));
    expect(el.textContent).toContain('Home location');
    const input = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = ' Berlin ';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(get).toHaveBeenCalledWith('/geocode', { q: 'Berlin' });
    const choice = el.querySelector<HTMLButtonElement>('.results button')!;
    expect(choice.textContent?.replace(/\s+/g, ' ').trim()).toBe('Berlin, State of Berlin, Germany');
    choice.click();
    expect(onChange).toHaveBeenCalledWith({ ...defaults, location: { name: 'Berlin', lat: 52.52437, lon: 13.41053 } });
  });

  it('does not search for fewer than two letters, and reports a failing search', async () => {
    const get = vi.fn(() => Promise.reject(new Error('down')));
    const el = render(client.Settings as NonNullable<typeof client.Settings>, props({ ...rejectingApi, get: get }));
    const input = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    const submit = (): void => void el.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    input.value = 'a';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    submit();
    await settle();
    expect(get).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('Type at least two letters.');
    input.value = 'Berlin';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    submit();
    await settle();
    expect(el.querySelector('[role="alert"]')?.textContent).toBe('The place search is not available right now.');
  });

  it('goes back to the home location and toggles what is shown', () => {
    const onChange = vi.fn();
    const withPlace = { ...defaults, location: { name: 'Paris', lat: 48.85, lon: 2.35 } };
    const el = render(client.Settings as NonNullable<typeof client.Settings>, props(rejectingApi, { value: withPlace, onChange }));
    expect(el.querySelector('[data-user]')?.textContent).toBe('Paris');
    const buttons = [...el.querySelectorAll('button')];
    buttons.find((b) => b.textContent?.includes('Use the home location'))!.click();
    expect(onChange).toHaveBeenLastCalledWith({ ...withPlace, location: null });
    const boxes = [...el.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]')];
    boxes[0]!.click(); // pollen off
    expect(onChange).toHaveBeenLastCalledWith({ ...withPlace, show: { pollen: false, air: true, uv: true } });
    const grass = boxes.find((b) => b.parentElement?.textContent?.includes('Grass'))!;
    grass.click();
    expect((onChange.mock.lastCall?.[0] as Settings).pollenTypes).toEqual(['alder', 'birch', 'mugwort', 'olive', 'ragweed']);
  });
});
