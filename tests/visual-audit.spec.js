const { test } = require('@playwright/test');

async function openDemo(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/', { waitUntil: 'commit', timeout: 5000 });
  await page.waitForSelector('body', { state: 'attached', timeout: 5000 });
  await page.waitForTimeout(5000);
  await page.evaluate(() => window.stop());
}

test('capture desktop visual audit', async ({ page }) => {
  test.setTimeout(45000);
  await openDemo(page, { width: 1440, height: 900 });
  await page.screenshot({ path: 'test-results/visual/desktop-home.png', fullPage: true });

  const actions = page.locator('#trackActionsButton');
  if ((await actions.count()) && (await actions.isVisible())) {
    await actions.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/visual/desktop-track-actions.png', fullPage: false });
  }
});

test('capture mobile visual audit', async ({ page }) => {
  test.setTimeout(45000);
  await openDemo(page, { width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/visual/mobile-home.png', fullPage: true });

  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/visual/mobile-scrolled.png', fullPage: false });

  const miniCopy = page.locator('#mobileMiniPlayer .mobile-mini-copy');
  if ((await miniCopy.count()) && (await miniCopy.isVisible())) {
    await miniCopy.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/visual/mobile-fullscreen.png', fullPage: false });
    const close = page.locator('#fullscreenClose');
    if ((await close.count()) && (await close.isVisible())) await close.click();
  }

  const more = page.locator('#dockMoreButton');
  if ((await more.count()) && (await more.isVisible())) {
    await more.click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: 'test-results/visual/mobile-more.png', fullPage: false });
  }
});
