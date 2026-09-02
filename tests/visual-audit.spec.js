const { test, expect } = require('@playwright/test');

async function openDemo(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode', { timeout: 12000 });
  await page.waitForTimeout(700);
}

test('capture desktop visual audit', async ({ page }) => {
  await openDemo(page, { width: 1440, height: 900 });
  await page.screenshot({ path: 'test-results/visual/desktop-home.png', fullPage: true });

  const actions = page.locator('#trackActionsButton');
  if (await actions.isVisible()) {
    await actions.click();
    await expect(page.locator('#uxTrackActionsDialog')).toBeVisible();
    await page.screenshot({ path: 'test-results/visual/desktop-track-actions.png', fullPage: false });
    await page.locator('#uxTrackActionsDialog .ux-dialog-close').click();
  }
});

test('capture mobile visual audit', async ({ page }) => {
  await openDemo(page, { width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/visual/mobile-home.png', fullPage: true });

  await page.evaluate(() => window.scrollTo(0, 900));
  await expect(page.locator('#mobileMiniPlayer')).toHaveClass(/visible/);
  await page.screenshot({ path: 'test-results/visual/mobile-scrolled.png', fullPage: false });

  await page.locator('#mobileMiniPlayer .mobile-mini-copy').click();
  await expect(page.locator('#fullscreenNowPlaying')).toBeVisible();
  await page.screenshot({ path: 'test-results/visual/mobile-fullscreen.png', fullPage: false });
  await page.locator('#fullscreenClose').click();

  await page.locator('#dockMoreButton').click();
  await expect(page.locator('#uxMoreDialog')).toBeVisible();
  await page.screenshot({ path: 'test-results/visual/mobile-more.png', fullPage: false });
});
