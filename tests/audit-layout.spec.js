const { test, expect } = require('@playwright/test');

for (const width of [320, 768, 1024, 1920]) {
  test(`music, radio and fullscreen fit ${width}px without runtime errors`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.locator('#connectionText')).toContainText('Preview mode');
    await expect(page.locator('#premiumOutputButton')).toBeVisible();
    for (const mode of ['music', 'radio']) {
      if (mode === 'radio') await page.locator('#modeToggle').click();
      const dimensions = await page.evaluate(() => ({
        width: innerWidth,
        body: document.body.scrollWidth,
        html: document.documentElement.scrollWidth,
      }));
      expect(dimensions.body, `${mode} body overflow`).toBeLessThanOrEqual(width + 1);
      expect(dimensions.html, `${mode} document overflow`).toBeLessThanOrEqual(width + 1);
      await page.locator('#playerArt').click();
      await expect(page.locator('#fullscreenNowPlaying')).toBeVisible();
      const box = await page.locator('#fullscreenNowPlaying').boundingBox();
      expect(box.width).toBeLessThanOrEqual(width);
      expect(box.height).toBeLessThanOrEqual(900);
      await page.locator('.fullscreen-close').click();
    }
    expect(errors).toEqual([]);
  });
}
