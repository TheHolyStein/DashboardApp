import { ADMIN, MEMBER, addClock, clockTile, expect, expectNoProblems, signIn, signOut, test } from './fixtures';

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

test('catalog lists the Clock module with its name and description', async ({ page, problems }) => {
  await signIn(page, ADMIN);
  await page.getByRole('button', { name: 'Edit page' }).click();
  await page.getByRole('button', { name: 'Add module' }).click();
  const catalog = page.getByRole('dialog', { name: 'Add a module' });
  await expect(catalog.getByText('Clock', { exact: true })).toBeVisible();
  await expect(catalog.getByText('Time in any zone, countdown timers and the next calendar event.')).toBeVisible();
  await expect(page.getByText('No modules installed')).toHaveCount(0);
  await expectNoProblems(problems);
});

test('add a page and switch', async ({ page, problems }) => {
  await signIn(page, ADMIN);
  await page.getByRole('tab', { name: 'Today' }).click();
  await expect(page).toHaveURL(/\/p\/[^/?#]+/);
  const todayUrl = page.url();

  await page.getByRole('button', { name: `Account menu for ${ADMIN.name}` }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
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
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
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
  await expect(page.getByRole('dialog', { name: 'Add a module' })).toBeVisible();
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
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
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

test('grid: drag and resize a tile in edit mode', async ({ page, problems }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await signIn(page, ADMIN);
  await addClock(page);
  const item = page.locator('.grid-stack-item[data-item-id]').filter({ has: page.locator('section[data-module-id="clock"]') }).last();
  const grid = (): Promise<{ x: number; y: number; w: number; h: number }> =>
    item.evaluate((el) => ({
      x: Number(el.getAttribute('gs-x') ?? 0),
      y: Number(el.getAttribute('gs-y') ?? 0),
      w: Number(el.getAttribute('gs-w') ?? 0),
      h: Number(el.getAttribute('gs-h') ?? 0),
    }));
  const id = await item.getAttribute('data-item-id');
  const start = await grid();

  // Drag right by about two columns. The press is offset from the tile corner and the move is made in many small
  // steps: gridstack starts a drag only after the pointer has moved a few pixels.
  const box = (await item.boundingBox())!;
  const col = (await page.locator('.grid-stack').boundingBox())!.width / 12;
  const fromX = box.x + 100;
  const fromY = box.y + 100;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(fromX + (i * 2.5 * col) / 30, fromY);
  await page.mouse.up();
  await expect.poll(async () => (await grid()).x).toBeGreaterThan(start.x);

  // Resize from the corner handle (shown on hover) by about two columns.
  const after = (await item.boundingBox())!;
  await item.hover();
  const hb = (await item.locator('.ui-resizable-se').boundingBox())!;
  const handleX = hb.x + hb.width / 2;
  const handleY = hb.y + hb.height / 2;
  await page.mouse.move(handleX, handleY);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(handleX + (i * 1.5 * col) / 30, handleY);
  await page.mouse.up();
  await expect.poll(async () => (await grid()).w).toBeGreaterThan(start.w);
  expect((await item.boundingBox())!.width).toBeGreaterThan(after.width);

  // The layout is saved: it survives a reload.
  const saved = await grid();
  // Saving is debounced (500 ms): wait until the server has the new size before reloading.
  await expect
    .poll(async () => {
      const pages = (await (await page.request.get('/api/pages')).json()) as Array<{ instances: Array<{ id: string; layout: { w: number } }> }>;
      return pages.flatMap((p) => p.instances).find((i) => i.id === id)?.layout.w;
    })
    .toBe(saved.w);
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Today' })).toBeVisible();
  const again = page.locator(`.grid-stack-item[data-item-id="${id ?? ''}"]`);
  await expect.poll(() => again.evaluate((el) => Number(el.getAttribute('gs-w')))).toBe(saved.w);
  await expectNoProblems(problems);
});

test('detail pane: dialog focus trap and Escape', async ({ page, problems }) => {
  await signIn(page, ADMIN);
  if ((await page.locator('section.tile[data-module-id="clock"]').count()) === 0) {
    await addClock(page);
    await page.getByRole('button', { name: 'Done' }).click();
  }
  const opener = clockTile(page).getByRole('button', { name: 'Clock' });
  await opener.focus();
  await page.keyboard.press('Enter');
  const pane = page.getByRole('dialog', { name: 'Clock' });
  await expect(pane).toBeVisible();
  expect(await pane.evaluate((el: HTMLDialogElement) => el.open && el.matches(':modal'))).toBe(true);

  // Tab around many times, forwards and backwards: focus is on a control of the dialog or, at the wrap point of a
  // native modal dialog, on the document body (the browser's own chrome); never on the page behind it.
  const insideOrBody = (): Promise<boolean> =>
    pane.evaluate((el) => el.contains(document.activeElement) || document.activeElement === document.body);
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    expect(await insideOrBody()).toBe(true);
  }
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Shift+Tab');
    expect(await insideOrBody()).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expectNoProblems(problems);
});
