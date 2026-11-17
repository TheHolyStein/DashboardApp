import '../fixtures/dialog.js';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pages } from '../../src/lib/pages.svelte.js';
import type { EditRegistry } from '../../src/lib/schema-form.js';
import { catalogUi, settingsUi } from '../../src/lib/ui-state.svelte.js';
import { editRegistry } from '../fixtures/editRegistry.js';
import EditShell from '../fixtures/EditShell.svelte';
import { server } from '../setup.js';
import { errorResponse, signIn } from './helpers.js';
import { inst, page, type Inst, type PageT } from './pageFixtures.js';

const clock = inst('c1', { moduleId: 'clock', settings: { title: 'Hello', refresh: 5 } });
const feeds = inst('f1', { moduleId: 'feeds', settings: { token: 'sek-ret', feeds: [], mode: 'list', compact: false }, layout: { x: 3, y: 0, w: 3, h: 2 }, mobileOrder: 1 });
const weird = inst('w1', { moduleId: 'weird', settings: {}, layout: { x: 0, y: 2, w: 3, h: 2 }, mobileOrder: 2 });
const custom = inst('x1', { moduleId: 'custom', settings: { text: 'abc' }, layout: { x: 3, y: 2, w: 3, h: 2 }, mobileOrder: 3 });

const ALL = { clock: 'edit', feeds: 'edit', weird: 'edit', custom: 'edit' } as const;

async function open(opts: { pgs?: PageT[]; grants?: Record<string, 'view' | 'edit'>; modules?: EditRegistry; userId?: string } = {}) {
  const modules = opts.modules ?? editRegistry();
  signIn({ id: opts.userId ?? 'u1', grants: opts.grants ?? { ...ALL } });
  const pgs = opts.pgs ?? [page('p1', [clock, feeds, weird, custom])];
  server.use(http.get('/api/pages', () => HttpResponse.json(pgs)));
  await pages.load();
  render(EditShell, { props: { modules } });
  await screen.findAllByRole('region').catch(() => undefined);
  return modules;
}

const tileSettings = async (instanceId: string) => {
  const tile = await waitFor(() => {
    const el = document.querySelector<HTMLElement>(`[data-instance-id="${instanceId}"]`);
    if (!el) throw new Error('tile missing');
    return el;
  });
  return await within(tile).findByRole('button', { name: 'Tile settings' });
};

beforeEach(() => {
  pages.clear();
  history.replaceState(null, '', '/');
  settingsUi.instanceId = null;
  catalogUi.open = false;
});
afterEach(() => {
  pages.clear();
});

function patchRecorder(respond?: (body: { settings: unknown }) => Response) {
  const calls: { id: string; body: { settings: Record<string, unknown> } }[] = [];
  server.use(
    http.patch('/api/instances/:id', async ({ params, request }) => {
      const body = (await request.json()) as { settings: Record<string, unknown> };
      calls.push({ id: String(params.id), body });
      if (respond) return respond(body);
      const base = [clock, feeds].find((i) => i.id === params.id) as Inst;
      return HttpResponse.json({ ...base, settings: body.settings });
    }),
  );
  return calls;
}

describe('settings dialog', () => {
  it('invalid input shows the zod message on the field', async () => {
    await open();
    const calls = patchRecorder();
    await userEvent.click(await tileSettings('c1'));
    const title = await screen.findByLabelText('Title');
    await userEvent.clear(title);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const msg = await screen.findByText(/expected string to have >=1 characters/i);
    expect(msg.getAttribute('role')).toBe('alert');
    expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(calls).toHaveLength(0);
  });

  it('saves coerced values with PATCH, updates the store and closes', async () => {
    await open();
    const calls = patchRecorder();
    await userEvent.click(await tileSettings('c1'));
    const title = await screen.findByLabelText('Title');
    await userEvent.clear(title);
    await userEvent.type(title, 'Desk');
    const refresh = screen.getByLabelText('Refresh');
    await userEvent.clear(refresh);
    await userEvent.type(refresh, '7');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ id: 'c1', body: { settings: { title: 'Desk', refresh: 7 } } });
    await waitFor(() => expect(screen.queryByLabelText('Title')).toBeNull());
    expect(pages.current?.instances.find((i) => i.id === 'c1')?.settings).toEqual({ title: 'Desk', refresh: 7 });
  });

  it('cancel discards without a request', async () => {
    await open();
    const calls = patchRecorder();
    await userEvent.click(await tileSettings('c1'));
    await userEvent.type(await screen.findByLabelText('Title'), 'zzz');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByLabelText('Title')).toBeNull());
    expect(calls).toHaveLength(0);
    expect(pages.current?.instances.find((i) => i.id === 'c1')?.settings).toEqual({ title: 'Hello', refresh: 5 });
  });

  it('server 422 issues land on the right fields, including a nested list path', async () => {
    await open();
    patchRecorder(() =>
      errorResponse('invalid', 422, 'invalid', [
        { path: ['feeds', 0, 'url'], message: 'Host not allowed' },
        { path: ['mode'], message: 'Mode rejected' },
      ]),
    );
    await userEvent.click(await tileSettings('f1'));
    await userEvent.click(await screen.findByRole('button', { name: 'Add' }));
    await userEvent.type(screen.getByLabelText('URL'), 'https://ok.example');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    const urlMsg = await screen.findByText('Host not allowed');
    expect(urlMsg.closest('.field')?.querySelector('input')?.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Mode rejected').closest('.field')?.querySelector('select')).toBeTruthy();
    expect(screen.getByLabelText('URL')).toBeTruthy(); // dialog stays open
  });

  it('other save errors show a general line', async () => {
    await open();
    patchRecorder(() => errorResponse('internal', 500));
    await userEvent.click(await tileSettings('c1'));
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Could not save the settings. Try again.')).toBeTruthy();
  });

  it('a module with its own Settings component gets it instead of the generated form', async () => {
    await open();
    const calls = patchRecorder((b) => HttpResponse.json({ ...custom, settings: b.settings }));
    await userEvent.click(await tileSettings('x1'));
    const input = await screen.findByTestId<HTMLInputElement>('custom-settings');
    expect(input.value).toBe('abc');
    await userEvent.type(input, 'd');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ settings: { text: 'abcd' } });
  });

  it('unsupported schema shows the cannot-be-edited message and the shell keeps working', async () => {
    await open();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await userEvent.click(await tileSettings('w1'));
      expect((await screen.findByTestId('settings-unsupported')).textContent).toContain('cannot be edited here');
      expect(spy).toHaveBeenCalledTimes(1);
      await userEvent.click(screen.getByText('Close', { selector: 'button' }));
    } finally {
      spy.mockRestore();
    }
    await waitFor(() => expect(screen.queryByTestId('settings-unsupported')).toBeNull());
    expect(document.querySelector('[data-instance-id="c1"]')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Tile settings' }).length).toBeGreaterThan(0);
  });

  it('settings button is absent for a non-owner and for level view', async () => {
    await open({ pgs: [page('p1', [clock], { ownerId: 'u2', shared: true })] });
    await waitFor(() => expect(document.querySelector('[data-instance-id="c1"]')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Tile settings' })).toBeNull();
  });

  it('settings button is absent for level view', async () => {
    await open({ grants: { clock: 'view' } });
    await waitFor(() => expect(document.querySelector('[data-instance-id="c1"]')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Tile settings' })).toBeNull();
  });

  it('secret field renders empty and an untouched secret is sent back unchanged', async () => {
    await open();
    const calls = patchRecorder();
    await userEvent.click(await tileSettings('f1'));
    const token = await screen.findByLabelText<HTMLInputElement>('Token');
    expect(token.type).toBe('password');
    expect(token.value).toBe('');
    expect(token.placeholder).toBe('Saved — leave empty to keep');
    expect(document.body.innerHTML).not.toContain('sek-ret');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body.settings.token).toBe('sek-ret');
  });

  it('a newly typed secret replaces the stored one', async () => {
    await open();
    const calls = patchRecorder();
    await userEvent.click(await tileSettings('f1'));
    await userEvent.type(await screen.findByLabelText('Token'), 'fresh');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body.settings.token).toBe('fresh');
  });
});

describe('catalog', () => {
  async function openCatalog() {
    await userEvent.click(await screen.findByRole('button', { name: 'Edit page' }));
    await userEvent.click(screen.getByRole('button', { name: 'Add module' }));
    return await screen.findByRole('dialog');
  }

  it('catalog hides modules without grant', async () => {
    await open({ pgs: [page('p1', [])], grants: { feeds: 'edit', clock: 'view' } });
    const dlg = await openCatalog();
    expect(within(dlg).getByText('Feeds')).toBeTruthy();
    expect(within(dlg).getByText('Clock')).toBeTruthy();
    expect(within(dlg).queryByText('Weird')).toBeNull();
    expect(within(dlg).queryByText('Custom')).toBeNull();
    await userEvent.type(within(dlg).getByRole('searchbox'), 'rss');
    expect(within(dlg).queryByText('Clock')).toBeNull();
    expect(within(dlg).getByText('Feeds')).toBeTruthy();
  });

  it('add places tile and POSTs instance', async () => {
    await open({ pgs: [page('p1', [clock])], grants: { feeds: 'edit', clock: 'edit' } });
    const bodies: unknown[] = [];
    server.use(
      http.post('/api/instances', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ...feeds, id: 'new1', pageId: 'p1', layout: { x: 3, y: 0, w: 3, h: 2 } }, { status: 201 });
      }),
    );
    const dlg = await openCatalog();
    await userEvent.click(within(dlg).getByRole('button', { name: /Feeds/ }));
    await waitFor(() => expect(document.querySelector('[data-instance-id="new1"]')).toBeTruthy());
    // The server chooses slot and size: the client sends no layout.
    expect(bodies).toEqual([{ moduleId: 'feeds', pageId: 'p1' }]);
    expect(pages.current?.instances.map((i) => i.id)).toEqual(['c1', 'new1']);
    await waitFor(() => expect(screen.queryByRole('searchbox')).toBeNull()); // catalog closed
  });

  it('shows an already placed single-instance module disabled with a note', async () => {
    await open({ pgs: [page('p1', [clock])], grants: { clock: 'edit', feeds: 'edit' } });
    const dlg = await openCatalog();
    const btn = within(dlg).getByRole<HTMLButtonElement>('button', { name: /Clock/ });
    expect(btn.disabled).toBe(true);
    expect(within(btn).getByText('Already added')).toBeTruthy();
    expect(within(dlg).getByRole<HTMLButtonElement>('button', { name: /Feeds/ }).disabled).toBe(false);
  });

  it.each([
    ['conflict', 409, 'This module is already on one of your pages.'],
    ['forbidden', 403, 'You do not have access to this module.'],
    ['not_found', 404, 'This module is not available.'],
  ])('%s from the server shows a specific message', async (code, status, message) => {
    await open({ pgs: [page('p1', [])], grants: { feeds: 'edit' } });
    server.use(http.post('/api/instances', () => errorResponse(code, status)));
    const dlg = await openCatalog();
    await userEvent.click(within(dlg).getByRole('button', { name: /Feeds/ }));
    expect((await within(dlg).findByRole('alert')).textContent).toBe(message);
    expect(pages.current?.instances).toHaveLength(0);
  });

  it('an empty registry says no modules are installed', async () => {
    await open({ pgs: [page('p1', [])], modules: {} });
    const dlg = await openCatalog();
    expect(within(dlg).getByText('No modules installed')).toBeTruthy();
  });
});

describe('edit mode', () => {
  it('remove asks for confirmation', async () => {
    await open({ pgs: [page('p1', [clock, feeds])] });
    const deletes: string[] = [];
    server.use(
      http.delete('/api/instances/:id', ({ params }) => {
        deletes.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull(); // not in edit mode
    await userEvent.click(await screen.findByRole('button', { name: 'Edit page' }));
    const removeClock = await screen.findByRole('button', { name: 'Remove Clock' });
    expect(removeClock.hasAttribute('data-edit')).toBe(true);

    // Cancel: nothing is sent, the tile stays.
    await userEvent.click(removeClock);
    const dlg = await screen.findByRole('dialog', { name: 'Remove tile?' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove tile?' })).toBeNull());
    expect(deletes).toEqual([]);
    expect(document.querySelector('[data-instance-id="c1"]')).toBeTruthy();
    expect(document.activeElement).toBe(removeClock);

    // Confirm: DELETE, then the tile is gone.
    await userEvent.click(removeClock);
    const dlg2 = await screen.findByRole('dialog', { name: 'Remove tile?' });
    await userEvent.click(within(dlg2).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(document.querySelector('[data-instance-id="c1"]')).toBeNull());
    expect(deletes).toEqual(['c1']);
    expect(document.querySelector('[data-instance-id="f1"]')).toBeTruthy();
  });

  it('toggles edit mode with the edit bar and Done', async () => {
    await open({ pgs: [page('p1', [clock])] });
    expect(pages.editing).toBe(false);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit page' }));
    expect(pages.editing).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(pages.editing).toBe(false);
    expect(screen.getByRole('button', { name: 'Edit page' })).toBeTruthy();
  });

  it('EditBar is hidden on a foreign shared page', async () => {
    await open({ pgs: [page('p1', [clock], { ownerId: 'u2', shared: true })] });
    await waitFor(() => expect(document.querySelector('[data-instance-id="c1"]')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Edit page' })).toBeNull();
    expect(screen.queryByRole('toolbar')).toBeNull();
  });
});
