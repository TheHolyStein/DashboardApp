import '../fixtures/dialog.js';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vitest';
import Account from '../../src/shell/settings/Account.svelte';
import { server } from '../setup.js';
import { errorResponse, signIn } from './helpers.js';

beforeEach(() => {
  signIn();
  server.use(http.get('/api/me/app-passwords', () => HttpResponse.json([])));
});

async function fillPassword(user: ReturnType<typeof userEvent.setup>, current: string, next: string, again = next) {
  await user.type(screen.getByLabelText('Current password'), current);
  await user.type(screen.getByLabelText('New password', { exact: true }), next);
  await user.type(screen.getByLabelText('New password again'), again);
  await user.click(screen.getByRole('button', { name: 'Change password' }));
}

describe('account: password', () => {
  it('wrong current password shows the specific message', async () => {
    server.use(http.post('/api/me/password', () => errorResponse('forbidden', 403, 'wrong', { reason: 'wrong_password' })));
    const user = userEvent.setup();
    render(Account);
    await fillPassword(user, 'nope', 'a-long-new-password');
    expect((await screen.findByText('The current password is incorrect.')).getAttribute('role')).toBe('alert');
  });

  it('checks length and repetition on the client without a request', async () => {
    let calls = 0;
    server.use(http.post('/api/me/password', () => (calls++, new HttpResponse(null, { status: 204 }))));
    const user = userEvent.setup();
    render(Account);
    await fillPassword(user, 'x', 'short1');
    // `minlength` blocks native submit in browsers; jsdom submits, so the script check answers
    expect(await screen.findByText(/must be 12 to 256 characters/)).toBeTruthy();
    expect(calls).toBe(0);
  });

  it('mismatching repetition is refused; success says other sessions were signed out', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post('/api/me/password', async ({ request }) => {
        bodies.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    render(Account);
    await fillPassword(user, 'old-password-1', 'a-long-new-password', 'a-long-new-passwore');
    expect(await screen.findByText('The new passwords do not match.')).toBeTruthy();
    expect(bodies).toEqual([]);
    await user.clear(screen.getByLabelText('New password again'));
    await user.type(screen.getByLabelText('New password again'), 'a-long-new-password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/other sessions were signed out/)).toBeTruthy();
    expect(bodies).toEqual([{ current: 'old-password-1', next: 'a-long-new-password' }]);
  });
});

describe('account: two-factor', () => {
  const SECRET = 'JBSWY3DPEHPK3PXP';
  const URL_ = `otpauth://totp/Dash:alice?secret=${SECRET}&issuer=Dash`;

  it('setup shows secret, URL and a local QR code; enabling needs a code', async () => {
    const enable: unknown[] = [];
    server.use(
      http.post('/api/me/totp/setup', () => HttpResponse.json({ secret: SECRET, otpauthUrl: URL_ })),
      http.post('/api/me/totp/enable', async ({ request }) => {
        enable.push(await request.json());
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    render(Account);
    await user.click(screen.getByRole('button', { name: 'Set up two-factor sign-in' }));
    expect((await screen.findByTestId('totp-secret')).textContent).toBe(SECRET);
    expect(screen.getByTestId('totp-url').textContent).toBe(URL_);
    const qr = await screen.findByRole('img', { name: 'QR code for two-factor setup' });
    expect(qr.querySelector('path')?.getAttribute('d')?.length).toBeGreaterThan(100);
    await user.type(screen.getByLabelText('Code from the app'), '123456');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText('Two-factor sign-in is on.')).toBeTruthy();
    expect(enable).toEqual([{ code: '123456' }]);
    expect(screen.queryByTestId('totp-secret')).toBeNull();
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set up two-factor sign-in' })).toBeNull();
  });

  it('a bad code and an already-enabled account give their own messages', async () => {
    server.use(
      http.post('/api/me/totp/setup', () => HttpResponse.json({ secret: SECRET, otpauthUrl: URL_ })),
      http.post('/api/me/totp/enable', () => errorResponse('invalid', 422)),
    );
    const user = userEvent.setup();
    render(Account);
    await user.click(screen.getByRole('button', { name: 'Set up two-factor sign-in' }));
    await user.type(await screen.findByLabelText('Code from the app'), '000000');
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    expect(await screen.findByText('That code is not valid. Try the next one.')).toBeTruthy();

    server.use(http.post('/api/me/totp/setup', () => errorResponse('conflict', 409)));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Set up two-factor sign-in' }));
    expect(await screen.findByText(/already on/)).toBeTruthy();
  });

  it('turning it off needs the password; a wrong one is reported', async () => {
    let ok = false;
    server.use(
      http.post('/api/me/totp/disable', () =>
        ok ? new HttpResponse(null, { status: 204 }) : errorResponse('forbidden', 403, 'x', { reason: 'wrong_password' }),
      ),
    );
    signIn({ totpEnabled: true });
    const user = userEvent.setup();
    render(Account);
    await user.type(screen.getByLabelText('Password (to turn it off)'), 'bad');
    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(await screen.findByText('The current password is incorrect.')).toBeTruthy();
    ok = true;
    await user.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(screen.getByText('Two-factor sign-in is off.')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Set up two-factor sign-in' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull();
  });

  it('shows set-up when two-factor is off and turn-off when it is on, never both', () => {
    const a = render(Account);
    expect(screen.getByRole('button', { name: 'Set up two-factor sign-in' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn off' })).toBeNull();
    a.unmount();
    signIn({ totpEnabled: true });
    render(Account);
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set up two-factor sign-in' })).toBeNull();
  });
});

describe('account: preferences', () => {
  it('saves locale and time zone through PATCH /me/prefs', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.patch('/api/me/prefs', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ...signIn(), prefs: { theme: 'default', modePolicy: 'system', locale: 'en', timeZone: 'Europe/Berlin' } });
      }),
    );
    const user = userEvent.setup();
    render(Account);
    await user.selectOptions(screen.getByLabelText('Time zone'), 'Europe/Berlin');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bodies).toEqual([{ locale: 'en', timeZone: 'Europe/Berlin' }]));
  });
});
