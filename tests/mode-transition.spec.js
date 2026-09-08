const { test, expect } = require('@playwright/test');

for (const variant of ['native', 'fallback', 'reduced']) {
  test(`Music/Radio transition stays consistent on rapid clicks: ${variant}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (variant === 'reduced') await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(variant => {
      window.__viewTransitions = 0;
      const start = document.startViewTransition?.bind(document);
      if (variant === 'fallback') document.startViewTransition = undefined;
      else if (start)
        document.startViewTransition = callback => {
          window.__viewTransitions++;
          return start(callback);
        };
    }, variant);
    await page.goto('/');
    await expect(page.locator('#connectionText')).toContainText('Preview mode');
    await page.evaluate(() => {
      const button = document.getElementById('modeToggle');
      button.click();
      button.click();
      button.click();
    });
    await expect(page.locator('body')).toHaveClass(/radio-mode/);
    await expect(page.locator('#radioView')).toBeVisible();
    await expect(page.locator('#musicView')).toBeHidden();
    await page.locator('#modeToggle').click();
    await expect(page.locator('body')).not.toHaveClass(/radio-mode/);
    await expect(page.locator('#musicView')).toBeVisible();
    await expect(page.locator('#radioView')).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.getAnimations().filter(a => /mode-(enter|leave)/.test(a.animationName || '')).length
        )
      )
      .toBe(0);
    expect(await page.evaluate(() => window.OWNTONE_APP.state.mode)).toBe('music');
    if (variant !== 'native') expect(await page.evaluate(() => window.__viewTransitions)).toBe(0);
    expect(errors).toEqual([]);
  });
}
