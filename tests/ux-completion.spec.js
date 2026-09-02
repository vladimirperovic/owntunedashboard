const { test, expect } = require('@playwright/test');

async function openDemo(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('#connectionText')).toContainText('Preview mode', { timeout: 12000 });
}

test('dashboard completes page load without the quarantined completion observer', async ({ page }) => {
  await openDemo(page, { width: 1280, height: 800 });

  await expect(page.locator('script[data-owntone-script="ux-completion.js"]')).toHaveCount(0);
  await expect(page.locator('#playerCard')).toBeVisible();
  await expect(page.locator('#premiumOutputButton')).toBeVisible();
});

test('music hero keeps the original light card treatment', async ({ page }) => {
  await openDemo(page, { width: 1280, height: 800 });

  const title = page.locator('#trackTitle');
  await expect(title).toBeVisible();
  await expect(title).toHaveCSS('color', 'rgb(11, 10, 9)');

  const card = page.locator('#playerCard');
  await expect(card).toHaveCSS('background-color', 'rgb(248, 242, 234)');
  await expect(card).toHaveCSS('border-color', 'rgba(255, 255, 255, 0.72)');

  const box = await card.boundingBox();
  expect(box.width).toBeGreaterThan(500);
  expect(box.height).toBeGreaterThan(250);
});

test('mobile core controls remain reachable after the load hotfix', async ({ page }) => {
  await openDemo(page, { width: 390, height: 844 });

  await expect(page.locator('.mobile-nav')).toBeVisible();
  await expect(page.locator('#playerCard')).toBeVisible();
  await expect(page.locator('#playButton')).toBeVisible();
  await expect(page.locator('#queueDrawerButton')).toBeVisible();
});
