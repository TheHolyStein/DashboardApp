import '../fixtures/dialog.js';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pages } from '../../src/lib/pages.svelte.js';
import { settingsArea } from '../../src/lib/ui-state.svelte.js';
import Account from '../../src/shell/settings/Account.svelte';
import Grants from '../../src/shell/settings/Grants.svelte';
import Modules from '../../src/shell/settings/Modules.svelte';
import PageManager from '../../src/shell/settings/PageManager.svelte';
import Users from '../../src/shell/settings/Users.svelte';
import SettingsArea from '../../src/shell/SettingsArea.svelte';
import { server } from '../setup.js';
import { errorResponse, signIn } from './helpers.js';
import { page } from './pageFixtures.js';
import { z } from 'zod';

const seen: string[] = [];
beforeEach(() => {
  seen.length = 0;
  server.events.on('request:start', ({ request }) => void seen.push(`${request.method} ${new URL(request.url).pathname}`));
  history.replaceState(null, '', '/');
  settingsArea.sync();
  pages.clear();
});
afterEach(() => {
  server.events.removeAllListeners();
  history.replaceState(null, '', '/');
  settingsArea.sync();
});

const users = [
  { id: 'u1', name: 'Alice', handle: 'alice', role: 'admin', disabled: false, totpEnabled: false, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'u2', name: 'Bob', handle: 'bob', role: 'member', disabled: false, totpEnabled: true, createdAt: '2026-01-02T00:00:00Z' },
];
const mods = [
  { id: 'clock', name: 'Clock', description: 'Time', version: '1.0.0', enabled: true, failed: false, levels: ['view', 'edit'], hasConfig: false },
  { id: 'notes', name: 'Notes', description: '', version: '1.0.0', enabled: true, failed: false, levels: ['view', 'edit'], hasConfig: false },
  { id: 'broken', name: 'Broken', description: '', version: '', enabled: false, failed: true, levels: [], hasConfig: false },
];
const registry = { clock: { manifest: { levels: ['view'] as const } }, notes: { manifest: { levels: ['view', 'edit'] as const } } };

function adminHandlers() {
  server.use(
    http.get('/api/admin/users', () => HttpResponse.json(users)),
    http.get('/api/admin/modules', () => HttpResponse.json(mods)),
    http.get('/api/admin/grants', () => HttpResponse.json([{ userId: 'u2', moduleId: 'notes', level: 'view' }])),
  );
}

describe('admin sections', () => {
  it('member does not see admin sections', async () => {
    signIn({ role: 'member' });
    settingsArea.show('users'); // a member following an admin link
    render(SettingsArea);
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    const names = within(nav).getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual(['Account', 'Appearance', 'Pages', 'About']);
    expect(screen.queryByText('Permissions')).toBeNull();
    // the admin URL falls back to the account section; no admin request is made
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Account' })).toBeTruthy());
    expect(seen.filter((s) => s.includes('/api/admin'))).toEqual([]);
  });

  it('a member rendering an admin screen directly never triggers /api/admin/*', async () => {
    signIn({ role: 'member' });
    render(Users);
    render(Grants, { props: { modules: registry } });
    render(Modules);
    await new Promise((r) => setTimeout(r, 30));
    expect(seen.filter((s) => s.includes('/api/admin'))).toEqual([]);
  });

  it('admins see all sections', async () => {
    signIn({ role: 'admin' });
    settingsArea.show('about');
    server.use(http.get('/api/health', () => HttpResponse.json({ ok: true, version: '1.2.3', contract: 4 })));
    render(SettingsArea);
    const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getAllByRole('button').map((b) => b.textContent)).toEqual(['Account', 'Appearance', 'Pages', 'Users', 'Permissions', 'Modules', 'About']);
    expect(await screen.findByText('App version 1.2.3')).toBeTruthy();
    expect(screen.getByText('Contract version 4')).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'About' }).getAttribute('aria-current')).toBe('page');
  });

  it('a 403 from an admin call shows a not-allowed state and does not retry', async () => {
    signIn({ role: 'admin' });
    server.use(http.get('/api/admin/users', () => errorResponse('forbidden', 403)));
    render(Users);
    expect((await screen.findByRole('alert')).textContent).toContain('not allowed');
    await new Promise((r) => setTimeout(r, 30));
    expect(seen.filter((s) => s === 'GET /api/admin/users')).toHaveLength(1);
  });

  it('About: settings area closes with Back', async () => {
    signIn();
    settingsArea.show('account');
    expect(location.search).toBe('?s=account');
    settingsArea.close();
    await waitFor(() => expect(true).toBe(true));
    history.back();
    await waitFor(() => expect(location.search).toBe(''));
    settingsArea.sync();
    expect(settingsArea.open).toBe(false);
  });
});

describe('grant matrix', () => {
  it('grant matrix only offers levels in manifest.levels', async () => {
    signIn({ role: 'admin' });
    adminHandlers();
    render(Grants, { props: { modules: registry } });
    const clockCell = await screen.findByLabelText('Bob: Clock');
    expect([...(clockCell as HTMLSelectElement).options].map((o) => o.value)).toEqual(['none', 'view']);
    const notesCell = screen.getByLabelText('Bob: Notes');
    expect([...(notesCell as HTMLSelectElement).options].map((o) => o.value)).toEqual(['none', 'view', 'edit']);
    expect((notesCell as HTMLSelectElement).value).toBe('view');
    // failed modules are not columns; admins are not editable
    expect(screen.queryByText('Broken')).toBeNull();
    expect(screen.getAllByText('edit (admin)')).toHaveLength(2);
    expect(screen.queryByLabelText('Alice: Clock')).toBeNull();
  });

  it('a cell change is sent at once, optimistic, and rolls back with an error on failure', async () => {
    signIn({ role: 'admin' });
    adminHandlers();
    const puts: unknown[] = [];
    let fail = true;
    server.use(
      http.put('/api/admin/grants', async ({ request }) => {
        puts.push(await request.json());
        return fail ? errorResponse('internal', 500) : new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    render(Grants, { props: { modules: registry } });
    const cell = await screen.findByLabelText<HTMLSelectElement>('Bob: Notes');
    await user.selectOptions(cell, 'edit');
    expect(puts).toEqual([{ userId: 'u2', moduleId: 'notes', level: 'edit' }]);
    await waitFor(() => expect(cell.value).toBe('view')); // rolled back
    expect((await screen.findByRole('alert')).textContent).toBe('Could not save.');
    fail = false;
    await user.selectOptions(cell, 'edit');
    await waitFor(() => expect(puts).toHaveLength(2));
    expect(cell.value).toBe('edit');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a 422 for an unsupported level is explained in the cell', async () => {
    signIn({ role: 'admin' });
    adminHandlers();
    server.use(http.put('/api/admin/grants', () => errorResponse('invalid', 422)));
    const user = userEvent.setup();
    render(Grants, { props: { modules: registry } });
    await user.selectOptions(await screen.findByLabelText('Bob: Notes'), 'edit');
    expect((await screen.findByRole('alert')).textContent).toBe('This module does not support that level.');
  });
});

describe('users', () => {
  it('lists users, marks the own row and shows the last-admin message on 409', async () => {
    signIn({ id: 'u1', role: 'admin' });
    adminHandlers();
    server.use(http.patch('/api/admin/users/:id', () => errorResponse('conflict', 409)));
    const user = userEvent.setup();
    render(Users);
    const own = (await screen.findByText('Alice')).closest('li') as HTMLElement;
    expect(within(own).getByText('(you)')).toBeTruthy();
    expect(within(screen.getByText('Bob').closest('li') as HTMLElement).queryByText('(you)')).toBeNull();
    await user.click(within(own).getByRole('button', { name: 'Make member' }));
    expect((await screen.findByRole('alert')).textContent).toContain('last administrator');
  });

  it('creates a user and deletes one after confirming', async () => {
    signIn({ id: 'u1', role: 'admin' });
    adminHandlers();
    const created: unknown[] = [];
    server.use(
      http.post('/api/admin/users', async ({ request }) => {
        const b = (await request.json()) as Record<string, string>;
        created.push(b);
        return HttpResponse.json({ ...users[1], id: 'u3', name: b.name, totpEnabled: false }, { status: 201 });
      }),
      http.delete('/api/admin/users/:id', () => new HttpResponse(null, { status: 204 })),
    );
    const user = userEvent.setup();
    render(Users);
    await user.type(await screen.findByLabelText('Name'), 'Carol');
    await user.type(screen.getByLabelText('Password'), 'a-long-password-1');
    await user.click(screen.getByRole('button', { name: 'Create user' }));
    expect(await screen.findByText('Carol')).toBeTruthy();
    expect(created).toEqual([{ name: 'Carol', password: 'a-long-password-1', role: 'member' }]);

    const bob = screen.getByText('Bob').closest('li') as HTMLElement;
    await user.click(within(bob).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByRole('button', { name: 'Delete', hidden: true }));
    await waitFor(() => expect(screen.queryByText('Bob')).toBeNull());
  });
});

describe('modules', () => {
  it('toggles a module and shows no form for a module without config', async () => {
    signIn({ role: 'admin' });
    adminHandlers();
    const bodies: unknown[] = [];
    server.use(
      http.put('/api/admin/modules/:id/enabled', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ id: 'clock', enabled: false });
      }),
    );
    const user = userEvent.setup();
    render(Modules, { props: { modules: { clock: { manifest: { config: z.object({}) } as never } } } });
    const clock = (await screen.findByText('Clock')).closest('li') as HTMLElement;
    expect(within(clock).queryByRole('button', { name: 'Configure' })).toBeNull();
    expect(screen.getByText('failed to load')).toBeTruthy();
    await user.click(within(clock).getByRole('switch'));
    await waitFor(() => expect(bodies).toEqual([{ enabled: false }]));
    expect(within(clock).getByRole<HTMLInputElement>('switch').checked).toBe(false);
  });

  it('edits the module-wide config through the generated form', async () => {
    signIn({ role: 'admin' });
    adminHandlers();
    server.use(http.get('/api/admin/modules', () => HttpResponse.json([{ ...mods[0], hasConfig: true }])));
    server.use(http.get('/api/admin/modules/clock/config', () => HttpResponse.json({ city: 'Berlin' })));
    const puts: unknown[] = [];
    server.use(
      http.put('/api/admin/modules/clock/config', async ({ request }) => {
        puts.push(await request.json());
        return HttpResponse.json({ city: 'Hamburg' });
      }),
    );
    const user = userEvent.setup();
    render(Modules, { props: { modules: { clock: { manifest: { config: z.object({ city: z.string() }) } as never } } } });
    await user.click(await screen.findByRole('button', { name: 'Configure' }));
    const field = await screen.findByLabelText('City');
    expect((field as HTMLInputElement).value).toBe('Berlin');
    await user.clear(field);
    await user.type(field, 'Hamburg');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(puts).toEqual([{ city: 'Hamburg' }]));
  });
});

describe('page management', () => {
  async function open(over = {}) {
    signIn({ id: 'u1', role: 'member', ...over });
    server.use(http.get('/api/pages', () => HttpResponse.json([page('p1', [], { name: 'Home' })])));
    await pages.load();
    return render(PageManager);
  }

  it('adds a page', async () => {
    await open();
    server.use(http.post('/api/pages', () => HttpResponse.json(page('p2', [], { name: 'Kitchen' }))));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('New page'), 'Kitchen');
    await user.click(screen.getByRole('button', { name: 'Add page' }));
    await waitFor(() => expect(pages.list.map((p) => p.name)).toEqual(['Home', 'Kitchen']));
  });

  it('shows the last-page message on 409 when deleting', async () => {
    await open();
    server.use(http.delete('/api/pages/:id', () => errorResponse('conflict', 409)));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    await user.click(within(dialog).getByRole('button', { name: 'Delete', hidden: true }));
    expect((await screen.findByRole('alert')).textContent).toBe('The last page cannot be deleted.');
    expect(pages.list).toHaveLength(1);
  });

  it('renames a page', async () => {
    await open();
    server.use(http.patch('/api/pages/:id', () => HttpResponse.json(page('p1', [], { name: 'Start' }))));
    const user = userEvent.setup();
    const input = screen.getByLabelText('Name');
    await user.clear(input);
    await user.type(input, 'Start');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(pages.list[0]?.name).toBe('Start'));
  });
});

describe('app passwords', () => {
  it('app password is displayed once', async () => {
    signIn();
    const PASSWORD = 'ABCD-EFGH-JKLM-NPQR-STUV-WXYZ';
    let created = false;
    server.use(
      http.get('/api/me/app-passwords', () =>
        HttpResponse.json(created ? [{ id: 'a1', label: 'Phone', scope: 'caldav', createdAt: '2026-01-01T00:00:00Z', lastUsedAt: null }] : []),
      ),
      http.post('/api/me/app-passwords', () => {
        created = true;
        return HttpResponse.json({ id: 'a1', label: 'Phone', password: PASSWORD }, { status: 201 });
      }),
    );
    const user = userEvent.setup();
    const { container } = render(Account);
    expect(container.textContent).toContain(`${location.origin}/dav/`);
    await user.type(await screen.findByLabelText('Label'), 'Phone');
    await user.click(screen.getByRole('button', { name: 'Create app password' }));

    const shown = await screen.findByLabelText<HTMLInputElement>('App password');
    expect(shown.value).toBe(PASSWORD);
    expect(shown.readOnly).toBe(true);
    // the list entry (from the server) has the label but never the password
    const entry = (await screen.findAllByText('Phone')).map((n) => n.closest('li')).find(Boolean) as HTMLElement;
    expect(entry.textContent).not.toContain(PASSWORD);

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(container.textContent).not.toContain(PASSWORD);
    expect(screen.queryByLabelText('App password')).toBeNull();
  });
});
