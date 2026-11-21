import '../fixtures/dialog.js';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detail } from '../../src/lib/detail.svelte.js';
import { pages } from '../../src/lib/pages.svelte.js';
import { stream } from '../../src/lib/stream.svelte.js';
import Both from '../fixtures/Both.svelte';
import { control } from '../fixtures/control.js';
import { fakeRegistry } from '../fixtures/registry.js';
import { server } from '../setup.js';
import { session } from '../../src/lib/session.svelte.js';
import { makeMe, signIn } from './helpers.js';
import { inst, page } from './pageFixtures.js';

const i1 = inst('i1', { moduleId: 'good' });
const i2 = inst('i2', { moduleId: 'boom' });
const pg = page('p1', [i1, i2]);

async function setup(url = '/p/p1', grants: Record<string, 'none' | 'view' | 'edit'> = { good: 'view', boom: 'view' }) {
  signIn({ grants });
  server.use(http.get('/api/pages', () => HttpResponse.json([pg])));
  history.replaceState(null, '', url);
  detail.sync();
  pages.clear();
  const reg = fakeRegistry();
  const view = render(Both, { props: { instances: pg.instances, page: pg, modules: reg.modules } });
  await pages.load();
  return { ...reg, view };
}

beforeEach(() => {
  control.throwTile = false;
  control.throwDetail = false;
});
afterEach(() => {
  history.replaceState(null, '', '/');
  detail.sync();
  pages.clear();
  for (const k of Object.keys(stream.snapshots)) delete stream.snapshots[k];
});

const dialog = () => screen.queryByRole('dialog');

describe('detail pane', () => {
  it('Escape closes pane and restores focus', async () => {
    await setup();
    const opener = await screen.findByTestId('opener');
    opener.focus();
    detail.open('i1');
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(await screen.findByTestId('detail')).toBeTruthy();
    screen.getByRole('button', { name: 'Close' }).focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it('opened by a frame click, Escape returns focus to the tile title button, not the body', async () => {
    await setup();
    await userEvent.click(await screen.findByTestId('plain-area'));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await screen.findByTestId('detail');
    screen.getByRole('button', { name: 'Close' }).focus();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(dialog()).toBeNull());
    const title = within(screen.getByTestId('slot-i1')).getByRole('button', { name: 'Good' });
    expect(document.activeElement).toBe(title);
  });

  it('falls back to the page region when the tile title button is gone', async () => {
    const region = document.createElement('div');
    region.tabIndex = -1;
    region.setAttribute('data-focus-fallback', '');
    document.body.append(region);
    try {
      await setup();
      await userEvent.click(await screen.findByTestId('plain-area'));
      await screen.findByTestId('detail');
      within(screen.getByTestId('slot-i1')).getByRole('button', { name: 'Good' }).remove();
      screen.getByRole('button', { name: 'Close' }).focus();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(dialog()).toBeNull());
      expect(document.activeElement).toBe(region);
    } finally {
      region.remove();
    }
  });

  it('the detail receives the saved locale and time zone', async () => {
    await setup();
    signIn({
      grants: { good: 'view', boom: 'view' },
      prefs: { theme: 'default', modePolicy: 'system', locale: 'de-DE', timeZone: 'Asia/Kolkata' },
    });
    detail.open('i1');
    const pane = await screen.findByRole('dialog');
    expect((await within(pane).findByTestId('format')).textContent).toBe('de-DE|Asia/Kolkata');
  });

  it('Back button closes pane', async () => {
    await setup();
    detail.open('i1');
    await screen.findByRole('dialog');
    expect(location.search).toBe('?d=i1');
    history.back();
    await waitFor(() => expect(dialog()).toBeNull());
    expect(location.search).toBe('');
    expect(location.pathname).toBe('/p/p1');
  });

  it('pane is full-screen under 700 px', async () => {
    const prev = window.innerWidth;
    try {
      window.innerWidth = 500;
      await setup();
      detail.open('i1');
      expect((await screen.findByRole('dialog')).classList.contains('full')).toBe(true);
    } finally {
      window.innerWidth = prev;
    }
  });

  it('closing through the close button goes back in history and keeps the page path', async () => {
    await setup();
    const before = history.length;
    detail.open('i1');
    await screen.findByRole('dialog');
    expect(history.length).toBe(before + 1);
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(location.pathname).toBe('/p/p1');
    expect(location.search).toBe('');
  });

  it('closing a pane that was loaded directly replaces the URL without going back', async () => {
    await setup('/p/p1?d=i1');
    expect(await screen.findByRole('dialog')).toBeTruthy();
    const back = vi.spyOn(history, 'back');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(back).not.toHaveBeenCalled();
    expect(location.pathname).toBe('/p/p1');
    expect(location.search).toBe('');
    back.mockRestore();
  });

  it('openDetail({ tab: "week" }) writes ?d=<id>&dp.tab=week and the Detail receives params.tab', async () => {
    await setup();
    await userEvent.click(await screen.findByRole('button', { name: 'open week' }));
    expect((await screen.findByTestId('tab')).textContent).toBe('week');
    expect(location.search).toBe('?d=i1&dp.tab=week');
    expect(location.pathname).toBe('/p/p1');
  });

  it('openDetail without params gives an empty params object; the detail close prop closes the pane', async () => {
    await setup();
    await userEvent.click(await screen.findByRole('button', { name: 'open plain' }));
    expect((await screen.findByTestId('tab')).textContent).toBe('none');
    await userEvent.click(screen.getByRole('button', { name: 'done' }));
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it('direct load with ?d=<id> opens the pane once pages are ready, with params from dp.*', async () => {
    await setup('/p/p1?d=i1&dp.tab=month');
    expect((await screen.findByTestId('tab')).textContent).toBe('month');
  });

  it('direct load with ?d=<unknown> cleans the URL silently and keeps the page path', async () => {
    await setup('/p/p1?d=nope&dp.tab=x&keep=1');
    await waitFor(() => expect(location.search).toBe('?keep=1'));
    expect(location.pathname).toBe('/p/p1');
    expect(dialog()).toBeNull();
  });

  it('an instance of a module without access is dropped from the URL', async () => {
    await setup('/p/p1?d=i1', { good: 'none', boom: 'view' });
    await waitFor(() => expect(location.search).toBe(''));
    expect(dialog()).toBeNull();
  });

  it('an instance of a module with a missing grant is dropped from the URL and not loaded', async () => {
    const { loads } = await setup('/p/p1?d=i1', { boom: 'view' });
    await waitFor(() => expect(location.search).toBe(''));
    expect(dialog()).toBeNull();
    expect(loads.good ?? 0).toBe(0);
  });

  it('revoking the grant while the pane is open closes it', async () => {
    await setup();
    detail.open('i1');
    await screen.findByRole('dialog');
    session.me = makeMe({ grants: { good: 'none', boom: 'view' } });
    await waitFor(() => expect(dialog()).toBeNull());
    expect(location.search).toBe('');
  });

  it('a throwing Detail shows the failure placeholder inside the pane, and retry re-mounts it', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await setup();
      control.throwDetail = true;
      detail.open('i1');
      expect(await screen.findByText('This module failed.')).toBeTruthy();
      expect(dialog()).toBeTruthy();
      control.throwDetail = false;
      const alert = screen.getByRole('alert');
      await userEvent.click(alert.querySelector('button')!);
      expect(await screen.findByTestId('detail')).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('a failed load() of the module shows the failure and retry loads again', async () => {
    const { failLoad, loads } = await setup();
    failLoad.add('good');
    // The tile load already happened; the pane loads again and fails once.
    const before = loads.good ?? 0;
    detail.open('i1');
    expect(await screen.findByText('This module failed.')).toBeTruthy();
    await userEvent.click(screen.getByRole('alert').querySelector('button')!);
    expect(await screen.findByTestId('detail')).toBeTruthy();
    expect(loads.good).toBe(before + 2);
  });
});
