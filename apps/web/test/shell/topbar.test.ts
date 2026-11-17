import '../fixtures/dialog.js';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextMode } from '../../src/lib/prefs.js';
import { session } from '../../src/lib/session.svelte.js';
import { settingsArea } from '../../src/lib/ui-state.svelte.js';
import TopBar from '../../src/shell/TopBar.svelte';
import { server } from '../setup.js';
import { errorResponse, makeMe, signIn } from './helpers.js';

beforeEach(() => {
  history.replaceState(null, '', '/');
  settingsArea.sync();
  server.use(http.get('/api/notifications', () => HttpResponse.json([])));
});
afterEach(() => {
  history.replaceState(null, '', '/');
  settingsArea.sync();
  document.title = '';
});

describe('top bar', () => {
  it('sets the document title and shows the user menu with aria-expanded', async () => {
    signIn({ name: 'Alice' });
    const user = userEvent.setup();
    render(TopBar, { props: { engine: { setPolicy: vi.fn() } } });
    expect(document.title).toBe('Dashboard');
    const menu = screen.getByRole('button', { name: 'Account menu for Alice' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    await user.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(settingsArea.section).toBe('account');
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull(); // menu closed
  });

  it('Escape closes the menu and returns focus to its button', async () => {
    signIn();
    const user = userEvent.setup();
    render(TopBar, { props: { engine: { setPolicy: vi.fn() } } });
    const menu = screen.getByRole('button', { name: /Account menu/ });
    await user.click(menu);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(menu.getAttribute('aria-expanded')).toBe('false'));
    await waitFor(() => expect(document.activeElement).toBe(menu));
  });

  it('sign out ends the session', async () => {
    signIn();
    server.use(http.post('/api/auth/logout', () => new HttpResponse(null, { status: 204 })));
    const user = userEvent.setup();
    render(TopBar, { props: { engine: { setPolicy: vi.fn() } } });
    await user.click(screen.getByRole('button', { name: /Account menu/ }));
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(session.status).toBe('signedOut'));
  });

  it('the mode toggle cycles day, night, system, sun and saves each step', async () => {
    expect(['day', 'night', 'system', 'sun'].map((p) => nextMode(p as never))).toEqual(['night', 'system', 'sun', 'day']);
    signIn({ prefs: { theme: 'default', modePolicy: 'day', locale: 'en', timeZone: 'UTC' } });
    const bodies: unknown[] = [];
    server.use(
      http.patch('/api/me/prefs', async ({ request }) => {
        const b = (await request.json()) as { modePolicy: 'day' | 'night' | 'system' | 'sun' };
        bodies.push(b);
        return HttpResponse.json(makeMe({ prefs: { theme: 'default', modePolicy: b.modePolicy, locale: 'en', timeZone: 'UTC' } }));
      }),
    );
    const engine = { setPolicy: vi.fn() };
    const user = userEvent.setup();
    render(TopBar, { props: { engine } });
    const toggle = () => screen.getByRole('button', { name: /^Colour mode/ });
    expect(toggle().getAttribute('aria-label')).toBe('Colour mode: Day. Switch to Night');
    await user.click(toggle());
    await waitFor(() => expect(session.me?.prefs.modePolicy).toBe('night'));
    await user.click(toggle());
    await waitFor(() => expect(session.me?.prefs.modePolicy).toBe('system'));
    expect(bodies).toEqual([{ modePolicy: 'night' }, { modePolicy: 'system' }]);
    expect(engine.setPolicy.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['night', 'system']);
  });

  it('a failed save puts the previous mode back and says so', async () => {
    signIn({ prefs: { theme: 'default', modePolicy: 'day', locale: 'en', timeZone: 'UTC' } });
    server.use(http.patch('/api/me/prefs', () => errorResponse('internal', 500)));
    const engine = { setPolicy: vi.fn() };
    const user = userEvent.setup();
    render(TopBar, { props: { engine } });
    await user.click(screen.getByRole('button', { name: /^Colour mode/ }));
    expect(await screen.findByText('Could not save the colour mode.')).toBeTruthy();
    expect(engine.setPolicy.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['night', 'day']);
    expect(session.me?.prefs.modePolicy).toBe('day');
  });
});
