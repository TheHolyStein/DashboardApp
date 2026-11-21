import { expect, test as base, type Page } from '@playwright/test';

export const ADMIN = { name: 'e2e-admin', role: 'admin', password: 'e2e-admin-password-1' };
export const MEMBER = { name: 'e2e-member', role: 'member', password: 'e2e-member-password-1' };

declare global {
  interface Window {
    __cspViolations: string[];
  }
}

/** Console errors, uncaught exceptions and CSP violations seen on a page. */
export interface Problems {
  console: string[];
  pageErrors: string[];
  csp(): Promise<string[]>;
}

export const test = base.extend<{ problems: Problems }>({
  // Playwright requires the destructuring pattern for the fixtures argument.
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => {
    const url = process.env['E2E_BASE_URL'];
    if (!url) throw new Error('E2E_BASE_URL is not set: the global setup did not run');
    await use(url);
  },
  problems: async ({ page }, use) => {
    const problems: Problems = {
      console: [],
      pageErrors: [],
      csp: async () => (await page.evaluate(() => window.__cspViolations ?? []).catch(() => [])),
    };
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    page.on('console', (m) => {
      if (m.type() === 'error') problems.console.push(m.text());
    });
    page.on('pageerror', (e) => problems.pageErrors.push(String(e)));
    await use(problems);
  },
});

export { expect };

/**
 * Known, accepted console noise (everything else fails a test): the browser logs a failed resource for the 401
 * that `GET /api/me` answers before sign-in. Nothing else is filtered; CSP violations always fail.
 */
const EXPECTED_401 = /^Failed to load resource: the server responded with a status of 401 \(Unauthorized\)$/;

export async function expectNoProblems(problems: Problems): Promise<void> {
  expect(problems.console.filter((m) => !EXPECTED_401.test(m))).toEqual([]);
  expect(problems.pageErrors).toEqual([]);
  expect(await problems.csp()).toEqual([]);
}

export async function signIn(page: Page, user: { name: string; password: string }): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Name').fill(user.name);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('tab', { name: 'Today' })).toBeVisible();
}

export async function signOut(page: Page, userName: string): Promise<void> {
  await page.getByRole('button', { name: `Account menu for ${userName}` }).click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

/** The first Clock tile on the page (earlier tests may have placed more). */
export const clockTile = (page: Page) => page.locator('section.tile[data-module-id="clock"]').first();

/** Edit mode on, Clock added from the catalog, edit mode left on. */
export async function addClock(page: Page): Promise<void> {
  const tiles = page.locator('section.tile[data-module-id="clock"]');
  const before = await tiles.count();
  await page.getByRole('button', { name: 'Edit page' }).click();
  await page.getByRole('button', { name: 'Add module' }).click();
  await page.getByRole('button', { name: /^Clock/ }).click();
  await page.keyboard.press('Escape'); // closes the catalog
  await expect(tiles).toHaveCount(before + 1);
  await expect(clockTile(page)).toBeVisible();
}
