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
 * Known, accepted console noise (everything else fails a test):
 * - the browser logs a failed resource for the 401 that `GET /api/me` answers before sign-in;
 * - PRODUCT BUG (reported, not fixed here): zod probes `new Function('')` in the shared i18n chunk, which the strict
 *   CSP (no `unsafe-eval`) reports as a violation although zod catches it. It shows up once per page load as a
 *   console error whose text is only the "Note that 'script-src' was not explicitly set" tail, and as a
 *   `securitypolicyviolation` event for directive `script-src` with blocked URI `eval`.
 *   The test "security headers and CSP hold" does NOT filter it and is marked test.fail() until the bug is fixed.
 */
const EXPECTED_401 = /^Failed to load resource: the server responded with a status of 401 \(Unauthorized\)$/;
const ZOD_EVAL_CONSOLE = /^ Note that 'script-src' was not explicitly set, so 'default-src' is used as a fallback\.$/;
const ZOD_EVAL_VIOLATION = /^script-src eval$/;

export async function expectNoProblems(problems: Problems, opts: { allowZodEval?: boolean } = {}): Promise<void> {
  const allowZod = opts.allowZodEval ?? true;
  expect(
    problems.console.filter((m) => !EXPECTED_401.test(m) && !(allowZod && ZOD_EVAL_CONSOLE.test(m))),
  ).toEqual([]);
  expect(problems.pageErrors).toEqual([]);
  expect((await problems.csp()).filter((v) => !(allowZod && ZOD_EVAL_VIOLATION.test(v)))).toEqual([]);
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
