import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import App from '../../src/shell/App.svelte';
import { server } from '../setup.js';
import { errorResponse, makeMe } from './helpers.js';

function signedOutServer() {
  server.use(http.get('/api/me', () => errorResponse('unauthenticated', 401)));
}

describe('login', () => {
  it('login flow with TOTP step', async () => {
    signedOutServer();
    const bodies: unknown[] = [];
    server.use(
      http.post('/api/auth/login', async ({ request }) => {
        const body = (await request.json()) as { totp?: string };
        bodies.push(body);
        if (!body.totp) return errorResponse('invalid', 422, 'totp required', { totpRequired: true });
        return HttpResponse.json(makeMe({ name: 'Alice' }));
      }),
    );
    const user = userEvent.setup();
    render(App);
    await user.type(await screen.findByLabelText('Name'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'pw');
    expect(screen.queryByLabelText('Authentication code')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const code = await screen.findByLabelText('Authentication code');
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('pw');
    await user.type(code, '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Signed in as Alice')).toBeTruthy();
    expect(bodies).toEqual([
      { name: 'alice', password: 'pw' },
      { name: 'alice', password: 'pw', totp: '123456' },
    ]);
  });

  it('shows a generic error and clears the password after a failed attempt', async () => {
    signedOutServer();
    server.use(http.post('/api/auth/login', () => errorResponse('unauthenticated', 401)));
    const user = userEvent.setup();
    render(App);
    await user.type(await screen.findByLabelText('Name'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'bad');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const alert = await screen.findByText(/Sign-in failed/);
    expect(alert.getAttribute('role')).toBe('alert');
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('alice');
  });

  it('shows the retry message on rate_limited', async () => {
    signedOutServer();
    server.use(http.post('/api/auth/login', () => errorResponse('rate_limited', 429, 'slow', { retryAfterSec: 600 })));
    const user = userEvent.setup();
    render(App);
    await user.type(await screen.findByLabelText('Name'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Too many attempts, try again in 10 minutes')).toBeTruthy();
  });

  it.each([[45, 'Too many attempts, try again in 45 seconds'], [60, 'Too many attempts, try again in 1 minute'], [61, 'Too many attempts, try again in 2 minutes']])('rate_limited %is wording', async (sec, text) => {
    signedOutServer();
    server.use(http.post('/api/auth/login', () => errorResponse('rate_limited', 429, 'slow', { retryAfterSec: sec })));
    const user = userEvent.setup();
    render(App);
    await user.type(await screen.findByLabelText('Name'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(text)).toBeTruthy();
  });

  it.each([
    ['invalid + totpRequired again', () => errorResponse('invalid', 422, 'totp', { totpRequired: true })],
    ['unauthenticated', () => errorResponse('unauthenticated', 401)],
  ])('wrong code in the TOTP step shows an error (%s)', async (_n, reply) => {
    signedOutServer();
    server.use(
      http.post('/api/auth/login', async ({ request }) => {
        const body = (await request.json()) as { totp?: string };
        return body.totp ? reply() : errorResponse('invalid', 422, 'totp required', { totpRequired: true });
      }),
    );
    const user = userEvent.setup();
    render(App);
    await user.type(await screen.findByLabelText('Name'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    const code = await screen.findByLabelText<HTMLInputElement>('Authentication code');
    expect(screen.queryByText(/incorrect/)).toBeNull();
    await user.type(code, '000000');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('The code or password is incorrect.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Authentication code').value).toBe('');
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('pw');
  });

  it('disables submit while a request is in flight', async () => {
    signedOutServer();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.post('/api/auth/login', async () => {
        await gate;
        return HttpResponse.json(makeMe());
      }),
    );
    const user = userEvent.setup();
    render(App);
    await user.type(await screen.findByLabelText('Name'), 'alice');
    await user.type(screen.getByLabelText('Password'), 'pw');
    const btn = screen.getByRole('button', { name: 'Sign in' });
    await user.click(btn);
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(true));
    release();
    expect(await screen.findByText('Signed in as Alice')).toBeTruthy();
  });

  it('sign out returns to the login form', async () => {
    server.use(
      http.get('/api/me', () => HttpResponse.json(makeMe())),
      http.post('/api/auth/logout', ({ request }) => {
        expect(request.headers.get('x-csrf')).toBe('csrf-token');
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    render(App);
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByLabelText('Password')).toBeTruthy();
  });
});
