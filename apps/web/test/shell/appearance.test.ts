import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pages } from '../../src/lib/pages.svelte.js';
import { loadIntensityOverride, recallTheme, rememberTheme } from '../../src/lib/prefs.js';
import Appearance from '../../src/shell/settings/Appearance.svelte';
import { server } from '../setup.js';
import { errorResponse, makeMe, signIn } from './helpers.js';
import { page } from './pageFixtures.js';

const registry = { default: { meta: { id: 'default', name: 'Default' } }, dusk: { meta: { id: 'dusk', name: 'Dusk' } } };
const backgrounds = [
  { id: 'aurora', name: 'Aurora' },
  { id: 'dunes', name: 'Dunes' },
];

function fakeEngine() {
  return {
    set: vi.fn(() => Promise.resolve()),
    setPolicy: vi.fn(),
    current: { backgrounds } as never,
  };
}

beforeEach(() => {
  localStorage.clear();
  pages.clear();
});

describe('appearance', () => {
  it('lists the injected registry; empty registry says so', () => {
    signIn();
    const { unmount } = render(Appearance, { props: { registry, engine: fakeEngine(), applyIntensity: () => {} } });
    expect(screen.getAllByRole('radio', { name: /Default|Dusk/ })).toHaveLength(2);
    unmount();
    render(Appearance, { props: { registry: {}, engine: fakeEngine(), applyIntensity: () => {} } });
    expect(screen.getByText('No themes installed.')).toBeTruthy();
  });

  it('previews a theme at once and persists it', async () => {
    signIn();
    const bodies: unknown[] = [];
    server.use(
      http.patch('/api/me/prefs', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(makeMe({ prefs: { theme: 'dusk', modePolicy: 'system', locale: 'en', timeZone: 'UTC' } }));
      }),
    );
    const engine = fakeEngine();
    const user = userEvent.setup();
    render(Appearance, { props: { registry, engine, applyIntensity: () => {} } });
    await user.click(screen.getByRole('radio', { name: 'Dusk' }));
    expect(engine.set).toHaveBeenCalledWith('dusk');
    await waitFor(() => expect(bodies).toEqual([{ theme: 'dusk' }]));
    expect(engine.set).toHaveBeenCalledTimes(1);
  });

  it('theme preview reverts when the PATCH fails', async () => {
    signIn();
    server.use(http.patch('/api/me/prefs', () => errorResponse('internal', 500)));
    const engine = fakeEngine();
    const user = userEvent.setup();
    render(Appearance, { props: { registry, engine, applyIntensity: () => {} } });
    await user.click(screen.getByRole('radio', { name: 'Dusk' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(engine.set.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['dusk', 'default']);
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Default' }).checked).toBe(true);
  });

  it('mode policy previews and reverts on failure', async () => {
    signIn();
    server.use(http.patch('/api/me/prefs', () => errorResponse('internal', 500)));
    const engine = fakeEngine();
    const user = userEvent.setup();
    render(Appearance, { props: { registry, engine, applyIntensity: () => {} } });
    await user.click(screen.getByRole('radio', { name: 'Night' }));
    await screen.findByRole('alert');
    expect(engine.setPolicy.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['night', 'system']);
  });

  it('background choice is saved for the current page when the user owns it', async () => {
    signIn({ id: 'u1' });
    server.use(http.get('/api/pages', () => HttpResponse.json([page('p1', [], { ownerId: 'u1' })])));
    await pages.load();
    const bodies: unknown[] = [];
    server.use(
      http.patch('/api/pages/p1', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json(page('p1', [], { ownerId: 'u1', background: 'dunes' }));
      }),
    );
    const user = userEvent.setup();
    render(Appearance, { props: { registry, engine: fakeEngine(), applyIntensity: () => {} } });
    const select = screen.getByLabelText<HTMLSelectElement>('Background of this page');
    expect([...select.options].map((o) => o.value)).toEqual(['', 'rotate', 'aurora', 'dunes']);
    await user.selectOptions(select, 'dunes');
    await waitFor(() => expect(bodies).toEqual([{ background: 'dunes' }]));
    expect(pages.list[0]?.background).toBe('dunes');
  });

  it('background choice is hidden for a non-owner', async () => {
    signIn({ id: 'u2' });
    server.use(http.get('/api/pages', () => HttpResponse.json([page('p1', [], { ownerId: 'u1', shared: true })])));
    await pages.load();
    render(Appearance, { props: { registry, engine: fakeEngine(), applyIntensity: () => {} } });
    expect(screen.queryByLabelText('Background of this page')).toBeNull();
  });

  it('intensity override is stored per device and passed to the governor', async () => {
    signIn();
    const apply = vi.fn();
    const user = userEvent.setup();
    render(Appearance, { props: { registry, engine: fakeEngine(), applyIntensity: apply } });
    await user.selectOptions(screen.getByLabelText('Animation on this device'), 'calm');
    expect(apply).toHaveBeenLastCalledWith('calm');
    expect(loadIntensityOverride()).toBe('calm');
    expect(localStorage.getItem('dash:intensity')).toBe('calm');
    await user.selectOptions(screen.getByLabelText('Animation on this device'), 'auto');
    expect(apply).toHaveBeenLastCalledWith(null);
    expect(loadIntensityOverride()).toBeNull();
  });
});

describe('remembered theme for the sign-in screen', () => {
  it('falls back to default/system, remembers the last prefs, ignores junk', () => {
    expect(recallTheme()).toEqual({ theme: 'default', modePolicy: 'system' });
    rememberTheme({ theme: 'dusk', modePolicy: 'night' });
    expect(recallTheme()).toEqual({ theme: 'dusk', modePolicy: 'night' });
    localStorage.setItem('dash:last-theme', '{"theme":"../x","modePolicy":"bogus"}');
    expect(recallTheme()).toEqual({ theme: 'default', modePolicy: 'system' });
    localStorage.setItem('dash:last-theme', 'not json');
    expect(recallTheme()).toEqual({ theme: 'default', modePolicy: 'system' });
  });
});
