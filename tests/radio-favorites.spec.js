const { test, expect } = require('@playwright/test');
const key = 'owntone-radio-favorites-v1';
const stationName = 'Radio Porto Montenegro';

async function openRadio(page) {
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode');
  await page.locator('#modeToggle').click();
  await expect(page.locator('#radioView')).toBeVisible();
}

test('existing Porto pin survives reload and a changed playlist ID', async ({ page }) => {
  await page.addInitScript(key => {
    if (localStorage.getItem(key) === null)
      localStorage.setItem(key, JSON.stringify(['library:playlist:17']));
  }, key);
  await openRadio(page);
  const card = page.locator('.radio-card').filter({ hasText: stationName });
  await expect(card).toHaveClass(/is-favorite/);
  await expect
    .poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key))
    .toEqual([stationName]);
  await page.reload();
  await page.locator('#modeToggle').click();
  await expect(card).toHaveClass(/is-favorite/);
  await card.evaluate(card => {
    card.dataset.uri = 'library:playlist:999';
    window.OWNTONE_ENHANCE_RADIO();
  });
  await expect(card).toHaveClass(/is-favorite/);
  await card.locator('.radio-favorite').click();
  await expect(card).not.toHaveClass(/is-favorite/);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), key)).toEqual([]);
});

test('player heart follows station pins and toggles them without starting playback', async ({ page }) => {
  await openRadio(page);
  const card = page.locator('.radio-card').filter({ hasText: stationName });
  await card.click();
  const heart = page.locator('.transport-row .current-favorite-control');
  await expect(heart).toHaveAttribute('aria-pressed', 'false');
  await card.locator('.radio-favorite').click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  const before = await page.evaluate(() => window.OWNTONE_APP.getSnapshot(['current', 'player']));
  await heart.click();
  await expect(card).not.toHaveClass(/is-favorite/);
  await expect(heart).toHaveAttribute('aria-pressed', 'false');
  await heart.click();
  await expect(card).toHaveClass(/is-favorite/);
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.OWNTONE_APP.getSnapshot(['current', 'player']))).toEqual(before);
});

test('a name-based legacy pin can be removed', async ({ page }) => {
  await page.addInitScript(
    ({ key, stationName }) => localStorage.setItem(key, JSON.stringify([stationName])),
    {
      key,
      stationName,
    }
  );
  await openRadio(page);
  const card = page.locator('.radio-card').filter({ hasText: stationName });
  await expect(card).toHaveClass(/is-favorite/);
  await card.locator('.radio-favorite').click();
  await expect(card).not.toHaveClass(/is-favorite/);
});
