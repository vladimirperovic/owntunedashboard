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

// documentElement.scrollWidth alone missed a real overflow: the topbar buttons
// pushed <body> to 433px inside a 390px viewport while <html> stayed at 390, so
// the page could be dragged sideways into a blank strip. Check both.
async function assertNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
  }));
  expect(dimensions.documentScrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
  expect(dimensions.bodyScrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
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
  await expect(page.locator('#multiroomSheet')).toHaveClass(/open/);
  await expect(page.locator('.multiroom-output-row').filter({ hasText: 'HomePod mini' })).toBeVisible();
  await expect(page.locator('.multiroom-volume').first()).toBeVisible();
  await page.locator('.multiroom-close').click();

  await page.locator('.album-info-button').first().click();
  await expect(page.locator('#albumDetailDialog')).toBeVisible();
  await expect(page.locator('[data-album-action="play"]')).toBeVisible();
  await expect(page.locator('[data-album-action="shuffle"]')).toBeVisible();
  await expect(page.locator('[data-album-action="queue"]')).toBeVisible();
  await expect(page.locator('.album-track-row').first()).toBeVisible();
  await page.locator('.album-dialog-close').click();

  await page.locator('#modeToggle').click();
  await expect(page.locator('body')).toHaveClass(/radio-mode/);
  await expect(page.locator('.radio-station-identity').first()).toBeVisible();
  await expect(page.locator('.radio-card').first()).toBeVisible();

  await page.locator('#playerArt').click();
  await expect(page.locator('#fullscreenNowPlaying')).toBeVisible();
  await expect(page.locator('#fullscreenTitle')).not.toHaveText('');
  await expect(page.locator('.fullscreen-controls')).toBeVisible();
  await page.locator('.fullscreen-close').click();

  const accent = await page.evaluate(
    () =>
      getComputedStyle(document.documentElement).getPropertyValue('--context-accent-rgb') ||
      getComputedStyle(document.documentElement).getPropertyValue('--context-accent-hue')
  );
  expect(accent.trim().length).toBeGreaterThan(0);

  await page.screenshot({ path: 'test-results/desktop-premium.png', fullPage: true });
});

test('mobile premium experience fits and keeps controls reachable', async ({ page }) => {
  await openDemo(page, { width: 390, height: 844 });
  await assertNoHorizontalOverflow(page);

  await expect(page.locator('.mobile-nav')).toBeVisible();
  await expect(page.locator('#desktopMiniQueue')).toBeHidden();

  await page.locator('.mobile-nav [data-nav="library"]').click();
  await page.waitForTimeout(650);
  await expect(page.locator('#mobileMiniPlayer')).toHaveClass(/visible/);
  await expect(page.locator('.mobile-nav [data-nav="library"]')).toHaveClass(/active/);

  await page.locator('.album-info-button').first().click();
  await expect(page.locator('#albumDetailDialog')).toBeVisible();
  const albumBox = await page.locator('#albumDetailDialog .premium-dialog-inner').boundingBox();
  expect(albumBox.width).toBeLessThanOrEqual(390);
  expect(albumBox.height).toBeLessThanOrEqual(844);
  await page.locator('.album-dialog-close').click();

  await page.locator('#premiumOutputButton').click();
  await expect(page.locator('#multiroomSheet')).toHaveClass(/open/);
  const sheetBox = await page.locator('.multiroom-panel').boundingBox();
  expect(sheetBox.width).toBeLessThanOrEqual(390);
  expect(sheetBox.height).toBeLessThanOrEqual(844);
  await page.locator('.multiroom-close').click();

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

test('mobile radio view fits the viewport and sizes its dock controls', async ({ page }) => {
  await openDemo(page, { width: 390, height: 844 });
  await page.locator('#modeToggle').click();
  await expect(page.locator('body')).toHaveClass(/radio-mode/);
  // Feature modules mount their dock buttons after the first render.
  await page.waitForTimeout(1200);

  await assertNoHorizontalOverflow(page);

  // .volume-output-row stacks below 620px, so any unstyled child stretches to
  // the full row width — the sleep button used to render 296x290.
  for (const selector of ['#sleepButton', '#muteButton', '.dock-heart']) {
    const control = page.locator(selector);
    if ((await control.count()) === 0) continue;
    const box = await control.first().boundingBox();
    expect(box.width, `${selector} width`).toBeLessThanOrEqual(64);
    expect(box.height, `${selector} height`).toBeLessThanOrEqual(64);
  }

  // Every radio card must stay inside the grid.
  const cards = await page.locator('.radio-card').all();
  expect(cards.length).toBeGreaterThan(0);
  for (const card of cards) {
    const box = await card.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(-1);
    expect(box.x + box.width).toBeLessThanOrEqual(391);
  }
});

test('an album cover that fails to load falls back to the record placeholder', async ({ page }) => {
  await openDemo(page, { width: 1440, height: 1000 });

  // Demo albums carry no artwork_url, so point one card at a URL that 404s and
  // check the card recovers instead of leaving an empty dark box.
  await page.evaluate(() => {
    const art = document.querySelector('.album-card .album-art');
    art.querySelector('.mini-record')?.remove();
    const img = document.createElement('img');
    img.alt = '';
    img.src = '/definitely-not-a-cover.png';
    art.prepend(img);
  });

  const placeholder = page.locator('.album-card .album-art .mini-record').first();
  await expect(placeholder).toBeVisible();
  await expect(page.locator('.album-card .album-art img').first()).toHaveCount(0);
});
