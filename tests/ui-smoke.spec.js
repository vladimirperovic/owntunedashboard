const { test, expect } = require('@playwright/test');

async function openDemo(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode', { timeout: 12000 });
  await expect(page.locator('#premiumOutputButton')).toBeVisible();
  await expect(page.locator('#trackInfoButton')).toBeVisible();
  await expect(page.locator('#premiumRecentlyPlayed')).toBeVisible();
  await expect(page.locator('.album-info-button').first()).toBeAttached();
}

async function assertNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
}

test('desktop premium experience renders and operates', async ({ page }) => {
  await openDemo(page, { width: 1440, height: 1000 });
  await assertNoHorizontalOverflow(page);

  await expect(page.locator('#desktopMiniQueue')).toBeVisible();
  await expect(page.locator('#playingFrom')).toBeVisible();
  await expect(page.locator('#playerArt')).toHaveAttribute('role', 'button');

  await page.locator('#trackInfoButton').click();
  await expect(page.locator('#premiumSheet')).toHaveClass(/open/);
  await expect(page.locator('#premiumSheetTitle')).toHaveText('Track details');
  await expect(page.locator('.premium-meta-grid')).toBeVisible();
  await page.locator('.premium-sheet .premium-close').click();

  await page.locator('#premiumOutputButton').click();
  await expect(page.locator('#premiumSheetTitle')).toHaveText('AirPlay output');
  await expect(page.locator('.premium-output-row')).toContainText('HomePod mini');
  await expect(page.locator('#premiumOutputVolume')).toBeVisible();
  await page.locator('.premium-sheet .premium-close').click();

  await page.locator('.album-info-button').first().click();
  await expect(page.locator('#albumDetailDialog')).toBeVisible();
  await expect(page.locator('[data-album-action="play"]')).toBeVisible();
  await expect(page.locator('[data-album-action="shuffle"]')).toBeVisible();
  await expect(page.locator('[data-album-action="queue"]')).toBeVisible();
  await expect(page.locator('.album-track-row').first()).toBeVisible();
  await page.locator('.album-dialog-close').click();

  await page.locator('#modeToggle').click();
  await expect(page.locator('body')).toHaveClass(/radio-mode/);
  await expect(page.locator('.radio-station-identity.has-image').first()).toBeVisible();
  await expect(page.locator('.radio-card').first()).toBeVisible();

  await page.locator('#playerArt').click();
  await expect(page.locator('#fullscreenNowPlaying')).toBeVisible();
  await expect(page.locator('#fullscreenTitle')).not.toHaveText('');
  await expect(page.locator('.fullscreen-controls')).toBeVisible();
  await page.locator('.fullscreen-close').click();

  const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--context-accent-rgb') || getComputedStyle(document.documentElement).getPropertyValue('--context-accent-hue'));
  expect(accent.trim().length).toBeGreaterThan(0);

  await page.screenshot({ path: 'test-results/desktop-premium.png', fullPage: true });
});

test('mobile premium experience fits and keeps controls reachable', async ({ page }) => {
  await openDemo(page, { width: 390, height: 844 });
  await assertNoHorizontalOverflow(page);

  await expect(page.locator('.mobile-nav')).toBeVisible();
  await expect(page.locator('#desktopMiniQueue')).toBeHidden();

  await page.locator('#albumsSection').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await expect(page.locator('#mobileMiniPlayer')).toHaveClass(/visible/);
  await expect(page.locator('.mobile-nav [data-nav="library"]')).toHaveClass(/active/);

  await page.locator('.album-info-button').first().click();
  await expect(page.locator('#albumDetailDialog')).toBeVisible();
  const albumBox = await page.locator('#albumDetailDialog .premium-dialog-inner').boundingBox();
  expect(albumBox.width).toBeLessThanOrEqual(390);
  expect(albumBox.height).toBeLessThanOrEqual(844);
  await page.locator('.album-dialog-close').click();

  await page.locator('#premiumOutputButton').click();
  await expect(page.locator('#premiumSheet')).toHaveClass(/open/);
  const sheetBox = await page.locator('.premium-sheet-panel').boundingBox();
  expect(sheetBox.width).toBeLessThanOrEqual(390);
  expect(sheetBox.height).toBeLessThanOrEqual(844);
  await page.locator('.premium-sheet .premium-close').click();

  await page.locator('#playerArt').scrollIntoViewIfNeeded();
  await page.locator('#playerArt').click();
  await expect(page.locator('#fullscreenNowPlaying')).toBeVisible();
  const fullBox = await page.locator('#fullscreenNowPlaying').boundingBox();
  expect(fullBox.width).toBeLessThanOrEqual(390);
  expect(fullBox.height).toBeLessThanOrEqual(844);
  await page.locator('.fullscreen-close').click();

  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: 'test-results/mobile-premium.png', fullPage: true });
});
