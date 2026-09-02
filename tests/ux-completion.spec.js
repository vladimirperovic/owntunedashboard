const { test, expect } = require('@playwright/test');

async function openDemo(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('#connectionText')).toContainText('Preview mode', { timeout: 12000 });
  await expect(page.locator('script[data-owntone-script="ux-completion-safe.js"]')).toHaveCount(1);
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

  const ambience = await card.evaluate(element => {
    const style = getComputedStyle(element, '::before');
    return {
      opacity: style.opacity,
      inset: [style.top, style.right, style.bottom, style.left],
      filter: style.filter,
    };
  });
  expect(ambience.opacity).toBe('0.26');
  expect(ambience.inset).toEqual(['0px', '0px', '0px', '0px']);
  expect(ambience.filter).toContain('blur(52px)');

  const box = await card.boundingBox();
  expect(box.width).toBeGreaterThan(500);
  expect(box.height).toBeGreaterThan(250);
});

test('desktop navigation has one History plus Browse and Insights', async ({ page }) => {
  await openDemo(page, { width: 1280, height: 800 });
  await expect(page.locator('[data-nav="recent"]')).toHaveCount(0);
  await expect(page.locator('#historyNavButton')).toContainText('History');
  await expect(page.locator('#historyNavButton')).not.toContainText('Now playing history');
  await expect(page.locator('#browseNavButton')).toBeVisible();
  await expect(page.locator('#insightsNavButton')).toBeVisible();
});

test('current-track heart favorites the track instead of starting Favorites', async ({ page }) => {
  await openDemo(page, { width: 1280, height: 800 });
  const heart = page.locator('.dock-heart');
  await expect(heart).toHaveAttribute('aria-label', 'Add current track to Favorites');
  await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await expect(heart).toHaveClass(/is-current-favorite/);
  await expect(page.locator('#trackTitle')).toHaveText('La Vie En Rose');
});

test('fullscreen exposes volume, favorite, track actions and queue', async ({ page }) => {
  await openDemo(page, { width: 1280, height: 800 });
  await page.locator('#playerArt').click();
  await expect(page.locator('#fullscreenNowPlaying')).toBeVisible();
  await expect(page.locator('#fullscreenVolumeRange')).toBeVisible();
  await expect(page.locator('#fullscreenFavoriteButton')).toBeVisible();
  await expect(page.locator('#fullscreenTrackActionsButton')).toBeVisible();
  await expect(page.locator('#fullscreenQueueButton')).toBeVisible();
});

test('mobile music hero keeps the faint pre-screensaver ambience', async ({ page }) => {
  await openDemo(page, { width: 390, height: 844 });

  const ambience = await page.locator('#playerCard').evaluate(element => {
    const style = getComputedStyle(element, '::before');
    return { opacity: style.opacity, top: style.top, filter: style.filter };
  });
  expect(ambience.opacity).toBe('0.065');
  expect(ambience.top).toBe('-32px');
  expect(ambience.filter).toContain('blur(42px)');
});

test('mobile navigation stays at five destinations and More uses the current track', async ({ page }) => {
  await openDemo(page, { width: 390, height: 844 });

  await expect(page.locator('.mobile-nav')).toBeVisible();
  await expect(page.locator('.mobile-nav button')).toHaveCount(5);
  await expect(page.locator('#muteNavButton')).toHaveCount(0);
  await expect(page.locator('#queueDrawerButton')).toBeHidden();
  await expect(page.locator('#leftMoreButton')).toBeVisible();
  await expect(page.locator('#dockMoreButton')).toBeVisible();

  const secondRow = page.locator('.dock-second-row');
  const output = secondRow.locator('#premiumOutputButton');
  const sleep = secondRow.locator('#sleepButton');
  await expect(output).toBeVisible();
  await expect(sleep).toBeVisible();
  const outputBox = await output.boundingBox();
  const sleepBox = await sleep.boundingBox();
  expect(Math.abs(outputBox.y + outputBox.height / 2 - (sleepBox.y + sleepBox.height / 2))).toBeLessThan(2);

  await page.locator('#leftMoreButton').click();
  await expect(page.locator('#safeTrackActionsDialog')).toBeVisible();
  await expect(page.locator('#safeTrackActionTitle')).toHaveText('La Vie En Rose');
  await expect(page.locator('#safeTrackActionTitle')).not.toHaveText('Mezzanine');
  await page.locator('#safeTrackActionsDialog .ux-dialog-close').click();

  await page.locator('#dockMoreButton').click();
  await expect(page.locator('#safeMoreDialog')).toBeVisible();
  await expect(page.locator('#safeMoreDialog [data-safe-more="queue"]')).toBeVisible();
  await expect(page.locator('#safeMoreDialog [data-safe-more="history"]')).toBeVisible();
  await expect(page.locator('#safeMoreDialog [data-safe-more="browse"]')).toBeVisible();
  await expect(page.locator('#safeMoreDialog [data-safe-more="insights"]')).toBeVisible();
  await expect(page.locator('#safeMoreDialog [data-safe-more="update"]')).toBeHidden();
});

test('mobile mini player opens fullscreen instead of only scrolling home', async ({ page }) => {
  await openDemo(page, { width: 390, height: 844 });
  await page.locator('.mobile-nav [data-nav="library"]').click();
  await expect(page.locator('#mobileMiniPlayer')).toHaveClass(/visible/);
  await page.locator('#mobileMiniPlayer').click({ position: { x: 90, y: 25 } });
  await expect(page.locator('#fullscreenNowPlaying')).toBeVisible();
});
