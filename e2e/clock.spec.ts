import { ADMIN, addClock, clockTile, expect, expectNoProblems, signIn, test } from './fixtures';

test('clock: add tile, seconds, open pane, timer notifies, escape closes', async ({ page, problems }) => {
  // The timer job runs every 5 s, so a 3-second timer is announced within 5 + 3 s; allow 12 s.
  test.setTimeout(60_000);
  await signIn(page, ADMIN);

  await addClock(page);
  const tile = clockTile(page);
  await expect(tile.locator('.clock-tile time')).toBeVisible();

  // Settings: show seconds.
  // In edit mode the tile's remove button covers the settings button (pointer clicks are intercepted): use the keyboard.
  await tile.getByRole('button', { name: 'Tile settings' }).focus();
  await page.keyboard.press('Enter');
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
  const badge = page.getByTestId('unread-badge');
  const before = (await badge.count()) === 0 ? 0 : Number(await badge.textContent());
  await pane.getByLabel('Label').fill('E2E tea');
  await pane.getByLabel('Minutes').fill('0');
  await pane.getByLabel('Seconds').fill('3');
  await pane.getByRole('button', { name: 'Start timer' }).click();
  await expect(pane.getByRole('button', { name: 'Cancel E2E tea' })).toBeVisible();
  await expect(badge).toHaveText(String(before + 1), { timeout: 12_000 });

  // Escape closes the pane.
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);

  // Opened from the keyboard (the tile's title button), Escape returns focus to that button.
  const opener = tile.getByRole('button', { name: 'Clock' });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(pane).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  await expect(opener).toBeFocused();

  await expectNoProblems(problems);
});
