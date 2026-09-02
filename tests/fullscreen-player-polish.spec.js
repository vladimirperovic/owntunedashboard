const { test, expect } = require('@playwright/test');

async function openFullscreen(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode', { timeout: 12000 });
  await expect(page.locator('#playerArt')).toHaveAttribute('role', 'button');
  await page.locator('#playerArt').click();
  await expect(page.locator('#fullscreenNowPlaying')).toBeVisible();
}

test('fullscreen contrast is full-bleed without a copy-column rectangle', async ({ page }) => {
  await openFullscreen(page, { width: 1366, height: 768 });

  await expect(page.locator('.fullscreen-stage')).toHaveCSS('display', 'none');

  const ambientBackground = await page.locator('.fullscreen-ambient').evaluate(element =>
    getComputedStyle(element, '::after').backgroundImage
  );
  expect(ambientBackground).toContain('radial-gradient');
  expect(ambientBackground).toContain('linear-gradient');

  const output = page.locator('#fullscreenOutputButton');
  await expect(output).toBeVisible();
  await expect(page.locator('.fullscreen-controls')).toBeVisible();
});

test('fullscreen controls remain reachable on a short landscape viewport', async ({ page }) => {
  await openFullscreen(page, { width: 1280, height: 650 });

  const art = await page.locator('.fullscreen-art').boundingBox();
  const output = await page.locator('#fullscreenOutputButton').boundingBox();

  expect(art.y).toBeGreaterThanOrEqual(0);
  expect(art.y + art.height).toBeLessThanOrEqual(651);
  expect(output.y).toBeGreaterThanOrEqual(0);
  expect(output.y + output.height).toBeLessThanOrEqual(651);
});
