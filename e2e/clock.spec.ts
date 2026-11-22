import type { Page } from '@playwright/test';
import { ADMIN, addClock, expect, expectNoProblems, signIn, test } from './fixtures';

/** The bell badge: its number, and whether it shows a capped value such as "9+". */
async function unread(page: Page): Promise<{ n: number; capped: boolean }> {
  const badge = page.getByTestId('unread-badge');
  if ((await badge.count()) === 0) return { n: 0, capped: false };
  const text = (await badge.textContent()) ?? '';
  return { n: Number(/\d+/.exec(text)?.[0] ?? 0), capped: text.includes('+') };
}

// What the test created, removed in afterEach through the API so a failing run leaves nothing behind.
let ownInstanceId: string | undefined;
let ownTimerLabel: string | undefined;

test.afterEach(async ({ page }) => {
  const instanceId = ownInstanceId;
  const label = ownTimerLabel;
  ownInstanceId = undefined;
  ownTimerLabel = undefined;
  if (!instanceId && !label) return;
  const csrf = ((await (await page.request.get('/api/me')).json()) as { csrf: string }).csrf;
  const headers = { 'X-CSRF': csrf };
  if (label) {
    const list = await page.request.get('/api/m/clock/timers');
    if (list.ok()) {
      const { timers } = (await list.json()) as { timers: Array<{ id: string; label: string }> };
      for (const timer of timers.filter((t) => t.label === label)) {
        await page.request.delete(`/api/m/clock/timers/${timer.id}`, { headers }); // 404 = already gone: fine
      }
    }
  }
  if (instanceId) await page.request.delete(`/api/instances/${instanceId}`, { headers }); // 404 = already gone: fine
});

test('clock: add tile, seconds, open pane, timer notifies, escape closes', async ({ page, problems }) => {
  // The timer job runs every 5 s, so a 3-second timer is announced within 5 + 3 s; allow 12 s.
  test.setTimeout(60_000);
  await signIn(page, ADMIN);

  // This test owns its tile: it is found by the instance id from the create response and removed in afterEach.
  const created = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/instances');
  await addClock(page);
  const instanceId = ((await (await created).json()) as { id: string }).id;
  ownInstanceId = instanceId;
  const tile = page.locator(`section.tile[data-instance-id="${instanceId}"]`);
  await expect(tile.locator('.clock-tile time')).toBeVisible();

  // Settings: show seconds.
  await tile.getByRole('button', { name: 'Tile settings' }).click();
  const settings = page.getByRole('dialog', { name: /^Settings: Clock/ });
  await settings.getByLabel(/seconds/i).check();
  await settings.getByRole('button', { name: 'Save' }).click();
  await expect(settings).toHaveCount(0);

  // The readout now has seconds and moves on within two seconds.
  const time = tile.locator('.clock-tile time');
  await expect(time).toHaveText(/^\d\d:\d\d:\d\d$/);
  const first = await time.textContent();
  await expect(time).not.toHaveText(first ?? '', { timeout: 2_000 });

  // Leave edit mode, open the pane by clicking the tile.
  await page.getByRole('button', { name: 'Done' }).click();
  await tile.locator('.clock-tile').click();
  const pane = page.getByRole('dialog', { name: 'Clock' });
  await expect(pane).toBeVisible();
  await expect(pane.getByRole('heading', { name: 'Timers' })).toBeVisible();

  // A 3-second timer notifies its owner: the bell badge goes up by one.
  const label = `E2E tea ${Math.random().toString(36).slice(2, 8)}`;
  ownTimerLabel = label;
  const before = await unread(page);
  await pane.getByLabel('Label').fill(label);
  await pane.getByLabel('Minutes').fill('0');
  await pane.getByLabel('Seconds').fill('3');
  await pane.getByRole('button', { name: 'Start timer' }).click();
  await expect(pane.getByRole('button', { name: `Cancel ${label}` })).toBeVisible();
  if (before.capped) {
    await expect(page.getByTestId('unread-badge')).toHaveText(/\+$/, { timeout: 12_000 }); // already "9+": cannot count further
  } else {
    await expect.poll(async () => (await unread(page)).n, { timeout: 12_000 }).toBe(before.n + 1);
  }

  // Escape closes the pane; opened by a frame click, focus returns to the tile's title button.
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  const opener = tile.getByRole('button', { name: 'Clock' });
  await expect(opener).toBeFocused();

  // Opened from the keyboard (the title button), Escape returns focus to that button too.
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(pane).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  await expect(opener).toBeFocused();

  await expectNoProblems(problems);
});
