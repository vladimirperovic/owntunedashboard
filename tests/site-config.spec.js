const { test, expect } = require('@playwright/test');

test('operator overrides load before modules and merge artwork with defaults', async ({ page }) => {
  await page.route('**/site-config.json', route =>
    route.fulfill({
      json: { manualVolume: 0, nightSafeMaxVolume: 4, radioArtwork: { Local: '/site-assets/local.svg' } },
    })
  );
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode');
  const config = await page.evaluate(() => window.OwnTone.config);
  expect(config.manualVolume).toBe(0);
  expect(config.nightSafeMaxVolume).toBe(4);
  expect(config.radioArtwork.Local).toBe('/site-assets/local.svg');
  expect(config.radioArtwork['Porto Montenegro']).toContain('porto-montenegro.svg');
});

for (const json of [{ manualVolume: 101 }, { pollMs: false }, { unknown: 'setting' }]) {
  test(`invalid operator settings block startup: ${JSON.stringify(json)}`, async ({ page }) => {
    await page.route('**/site-config.json', route => route.fulfill({ json }));
    await page.goto('/');
    await expect(page.locator('#connectionText')).toContainText('Configuration error:');
    expect(await page.evaluate(() => Boolean(window.OWNTONE_APP))).toBe(false);
  });
}

test('unreadable operator settings cannot silently restore playback defaults', async ({ page }) => {
  await page.route('**/site-config.json', route => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Configuration error:');
  expect(await page.evaluate(() => Boolean(window.OWNTONE_APP))).toBe(false);
});
