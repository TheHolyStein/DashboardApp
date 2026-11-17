import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotifications, isSafeAppUrl, type Notification } from '../../src/lib/notifications.svelte.js';
import { pages } from '../../src/lib/pages.svelte.js';
import { api } from '../../src/lib/api.js';
import NotificationToasts from '../../src/shell/NotificationToasts.svelte';
import Notifications from '../../src/shell/Notifications.svelte';
import { server } from '../setup.js';
import { errorResponse, signIn } from './helpers.js';
import { inst, page } from './pageFixtures.js';

function n(id: string, over: Partial<Notification> = {}): Notification {
  return { id, moduleId: 'feeds', level: 'info', title: `Title ${id}`, body: null, url: null, createdAt: `2026-11-17T10:0${id.slice(-1)}:00.000Z`, readAt: null, ...over };
}

function rig(initial: Notification[] = []) {
  const handlers: Array<(e: { type: 'notification'; notification: Notification }) => void> = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  server.use(http.get('/api/notifications', () => HttpResponse.json(initial)));
  const store = createNotifications({
    api,
    stream: { on: (_t, fn) => (handlers.push(fn), () => void handlers.splice(handlers.indexOf(fn), 1)) },
    now: () => new Date('2026-11-17T12:00:00.000Z'),
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: () => {},
  });
  const emit = (notification: Notification) => handlers.forEach((h) => h({ type: 'notification', notification }));
  return { store, emit, timers };
}

afterEach(() => {
  pages.clear();
});

describe('notifications store', () => {
  it('loads the latest 20 on start and counts unread', async () => {
    let url = '';
    const { store } = rig();
    server.use(
      http.get('/api/notifications', ({ request }) => {
        url = request.url;
        return HttpResponse.json([n('n2'), n('n1', { readAt: '2026-11-17T11:00:00.000Z' })]);
      }),
    );
    store.start();
    await waitFor(() => expect(store.items).toHaveLength(2));
    expect(new URL(url).searchParams.get('limit')).toBe('20');
    expect(store.unread).toBe(1);
  });

  it('a notification arriving on the stream increments the badge and critical raises an alert toast', async () => {
    signIn();
    const { store, emit } = rig();
    store.start();
    await waitFor(() => expect(store.loaded).toBe(true));
    render(Notifications, { props: { store, modules: {} } });
    render(NotificationToasts, { props: { store } });
    expect(screen.queryByTestId('unread-badge')).toBeNull();

    emit(n('n3'));
    expect((await screen.findByTestId('unread-badge')).textContent).toBe('1');
    const status = screen.getByRole('status');
    expect(within(status).getByText('Title n3')).toBeTruthy();

    emit(n('n4', { level: 'critical', title: 'Disk failing' }));
    await waitFor(() => expect(screen.getByTestId('unread-badge').textContent).toBe('2'));
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('Disk failing')).toBeTruthy();
    expect(within(status).queryByText('Disk failing')).toBeNull();
  });

  it('non-critical toasts fade, critical ones stay until dismissed', () => {
    const { store, emit, timers } = rig();
    store.start();
    emit(n('n3'));
    emit(n('n4', { level: 'critical' }));
    expect(store.toasts).toHaveLength(2);
    expect(timers).toHaveLength(1); // only the info toast has a timer
    timers[0]?.fn();
    expect(store.toasts.map((t) => t.notification.id)).toEqual(['n4']);
    store.dismissToast(store.toasts[0]!.key);
    expect(store.toasts).toHaveLength(0);
  });

  it('mark-all-read is optimistic and rolls back on failure', async () => {
    const { store } = rig([n('n2'), n('n1')]);
    store.start();
    await waitFor(() => expect(store.unread).toBe(2));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.post('/api/notifications/read', async () => {
        await gate;
        return errorResponse('internal', 500);
      }),
    );
    const done = store.markRead('all');
    expect(store.unread).toBe(0); // optimistic, before the server answers
    release();
    expect(await done).toBe(false);
    expect(store.unread).toBe(2); // rolled back
  });

  it('mark read keeps the change on success and sends the ids', async () => {
    const { store } = rig([n('n2'), n('n1')]);
    store.start();
    await waitFor(() => expect(store.unread).toBe(2));
    const bodies: unknown[] = [];
    server.use(
      http.post('/api/notifications/read', async ({ request }) => {
        bodies.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    expect(await store.markRead(['n1'])).toBe(true);
    expect(bodies).toEqual([{ ids: ['n1'] }]);
    expect(store.unread).toBe(1);
  });

  it('clear() empties everything and stops listening', async () => {
    const { store, emit } = rig([n('n1')]);
    store.start();
    await waitFor(() => expect(store.items).toHaveLength(1));
    store.clear();
    emit(n('n2'));
    expect(store.items).toEqual([]);
    expect(store.toasts).toEqual([]);
  });
});

describe('notification links', () => {
  it('only same-origin relative paths are followed', () => {
    expect(isSafeAppUrl('/p/abc?d=x')).toBe(true);
    for (const bad of ['https://evil.example/x', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'p/abc', '/a\nb', null]) {
      expect(isSafeAppUrl(bad), String(bad)).toBe(false);
    }
  });

  it('a relative url navigates in-app and marks read; an absolute or protocol-relative one is not followed', async () => {
    signIn();
    const { store } = rig([
      n('n3', { url: '/p/page2' }),
      n('n2', { url: 'https://evil.example/steal' }),
      n('n1', { url: '//evil.example/x' }),
    ]);
    store.start();
    await waitFor(() => expect(store.items).toHaveLength(3));
    const reads: unknown[] = [];
    server.use(
      http.post('/api/notifications/read', async ({ request }) => {
        reads.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    history.replaceState(null, '', '/');
    const pushes = vi.spyOn(history, 'pushState');
    const user = userEvent.setup();
    render(Notifications, { props: { store, modules: {} } });
    await user.click(screen.getByRole('button', { name: /Notifications, 3 unread/ }));

    // the unsafe urls are shown as text, never as links
    const shownUrls = screen.getAllByTestId('unsafe-url').map((e) => e.textContent);
    expect(shownUrls).toEqual(['https://evil.example/steal', '//evil.example/x']);
    expect(document.querySelectorAll('a')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /Title n2/ }));
    await user.click(screen.getByRole('button', { name: /Title n1/ }));
    expect(pushes).not.toHaveBeenCalled();
    expect(location.pathname).toBe('/');

    await user.click(screen.getByRole('button', { name: /Title n3/ }));
    expect(pushes).toHaveBeenCalledWith(null, '', '/p/page2');
    expect(location.pathname).toBe('/p/page2');
    await waitFor(() => expect(reads).toHaveLength(3));
    pushes.mockRestore();
    history.replaceState(null, '', '/');
  });
});

describe('notifications dropdown', () => {
  it('shows level, title, body as text only, module and time; Escape closes and returns focus', async () => {
    signIn();
    const { store } = rig([n('n1', { level: 'warn', body: '<b>bold</b>', moduleId: 'feeds' })]);
    store.start();
    await waitFor(() => expect(store.items).toHaveLength(1));
    const user = userEvent.setup();
    render(Notifications, { props: { store, modules: { feeds: { manifest: { name: 'Feeds' } } } } });
    const bell = screen.getByRole('button', { name: /Notifications/ });
    expect(bell.getAttribute('aria-expanded')).toBe('false');
    await user.click(bell);
    expect(bell.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('<b>bold</b>')).toBeTruthy(); // text, not markup
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByRole('img', { name: 'Warning' })).toBeTruthy();
    expect(screen.getByText(/Feeds · /)).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(bell.getAttribute('aria-expanded')).toBe('false'));
    await waitFor(() => expect(document.activeElement).toBe(bell));
  });

  it('"View all" appears only when the user has a notifications instance', async () => {
    signIn();
    const { store } = rig([]);
    const user = userEvent.setup();
    render(Notifications, { props: { store, modules: {} } });
    await user.click(screen.getByRole('button', { name: /Notifications/ }));
    expect(screen.queryByRole('button', { name: 'View all' })).toBeNull();

    server.use(http.get('/api/pages', () => HttpResponse.json([page('p1', [inst('i1', { moduleId: 'notifications' })])])));
    await pages.load();
    expect(await screen.findByRole('button', { name: 'View all' })).toBeTruthy();
    history.replaceState(null, '', '/');
  });
});
