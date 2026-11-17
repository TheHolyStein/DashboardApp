import { ADMIN, MEMBER, expect, expectNoProblems, signIn, signOut, test } from './fixtures';

const rootVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

test('sign-in, empty page, sign-out', async ({ page, problems }) => {
  await signIn(page, ADMIN);
  await expect(page.getByRole('tab', { name: 'Today' })).toHaveAttribute('aria-selected', 'true');
  await signOut(page, ADMIN.name);
  await expectNoProblems(problems);
});

test('default theme and day/night switch', async ({ page, problems }) => {
  await signIn(page, ADMIN);
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-theme', 'default');
  const before = await html.getAttribute('data-mode');
  expect(before).toMatch(/^(day|night)$/);
  const bgBefore = await page.evaluate(rootVar, '--db-bg');
  expect(bgBefore).not.toBe('');
  // The toggle cycles day, night, system, sun: one of the first two clicks flips the resolved mode.
  const toggle = page.getByRole('button', { name: /^Colour mode:/ });
  for (let i = 0; i < 4 && (await html.getAttribute('data-mode')) === before; i++) await toggle.click();
  await expect(html).not.toHaveAttribute('data-mode', before ?? '');
  const bgAfter = await page.evaluate(rootVar, '--db-bg');
  expect(bgAfter).not.toBe('');
  expect(bgAfter).not.toBe(bgBefore);
  await expectNoProblems(problems);
});

test('catalog shows no modules installed', async ({ page, problems }) => {
  await signIn(page, ADMIN);
  await page.getByRole('button', { name: 'Edit page' }).click();
  await page.getByRole('button', { name: 'Add module' }).click();
  await expect(page.getByText('No modules installed')).toBeVisible();
  await expectNoProblems(problems);
});

test('add a page and switch', async ({ page, problems }) => {
  await signIn(page, ADMIN);
  await page.getByRole('tab', { name: 'Today' }).click();
  await expect(page).toHaveURL(/\/p\/[^/?#]+/);
  const todayUrl = page.url();

  await page.getByRole('button', { name: `Account menu for ${ADMIN.name}` }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Pages' }).click();
  await page.getByLabel('New page').fill('Garage');
  await page.getByRole('button', { name: 'Add page' }).click();
  await page.keyboard.press('Escape');

  const tab = page.getByRole('tab', { name: 'Garage' });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/\/p\/[^/?#]+/);
  expect(page.url()).not.toBe(todayUrl);

  await page.goBack();
  await expect(page).toHaveURL(todayUrl);
  await expect(page.getByRole('tab', { name: 'Today' })).toHaveAttribute('aria-selected', 'true');
  await expectNoProblems(problems);
});

test('member sees no admin sections and gets no admin data', async ({ page, problems }) => {
  const adminRequests: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/admin/')) adminRequests.push(r.url());
  });
  await signIn(page, MEMBER);
  await page.getByRole('button', { name: `Account menu for ${MEMBER.name}` }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav.getByRole('button', { name: 'Account' })).toBeVisible();
  for (const admin of ['Users', 'Permissions', 'Modules']) {
    await expect(nav.getByRole('button', { name: admin })).toHaveCount(0);
  }
  // Even by URL: the member lands on the account section and no admin request is sent.
  await page.goto('/?s=users');
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  expect(adminRequests).toEqual([]);
  await expectNoProblems(problems);
});

test('security headers and CSP hold', async ({ page, problems }) => {
  const res = await page.goto('/');
  const headers = res?.headers() ?? {};
  const csp = headers['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(headers['x-content-type-options']).toBe('nosniff');
  await signIn(page, ADMIN);
  await page.getByRole('button', { name: 'Edit page' }).click();
  await page.getByRole('button', { name: 'Add module' }).click();
  await expect(page.getByText('No modules installed')).toBeVisible();
  await expectNoProblems(problems);
});

test('service worker never serves api', async ({ page, context }) => {
  await signIn(page, ADMIN);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // The worker controls pages loaded after it activated.
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await expect(page.getByRole('tab', { name: 'Today' })).toBeVisible();

  await context.setOffline(true);
  const failed = await page.evaluate(() => fetch('/api/me').then(() => false, () => true));
  expect(failed).toBe(true);

  await page.reload();
  await expect(page.getByTestId('offline-banner')).toHaveText('Offline — showing last data');
  await expect(page.getByRole('tab', { name: 'Today' })).toBeVisible();
  await context.setOffline(false);
});

test('pwa manifest is served and the worker registers from /sw.js', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const manifest = await request.get(href ?? '');
  expect(manifest.ok()).toBe(true);
  const body = (await manifest.json()) as { name?: string; icons?: unknown[]; start_url?: string };
  expect(body.name).toBeTruthy();
  expect(Array.isArray(body.icons) && body.icons.length > 0).toBe(true);

  const sw = await request.get('/sw.js');
  expect(sw.ok()).toBe(true);
  expect(sw.headers()['cache-control']).toContain('no-cache');
  const scriptURL = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL ?? '');
  expect(new URL(scriptURL).pathname).toBe('/sw.js');
});

test('background layer shows behind a transparent shell', async ({ page, problems }) => {
  await signIn(page, ADMIN);
  // Pick the first non-default background of the Default theme for this page through Appearance.
  await page.getByRole('button', { name: `Account menu for ${ADMIN.name}` }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Appearance' }).click();
  await page.getByLabel('Background of this page').selectOption({ label: 'Gradient' });
  await page.keyboard.press('Escape');
  const layer = page.locator('.wash');
  await expect(layer).toHaveCount(1);
  await expect(layer).toHaveCSS('position', 'absolute');
  const shellBg = await page.locator('main.signed-in').evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(shellBg).toMatch(/^rgba\(0, 0, 0, 0\)$|^transparent$/);
  await expectNoProblems(problems);
});

test.skip('grid: drag and resize a tile in edit mode', () => {
  // Needs a dashboard module to place a tile; none exist yet. Re-check when the first module lands.
});

test.skip('detail pane: dialog focus trap and Escape', () => {
  // Needs a module with a detail view; none exist yet. Re-check when the first module lands.
});
