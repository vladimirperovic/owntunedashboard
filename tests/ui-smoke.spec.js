const { test, expect } = require('@playwright/test');

async function openDemo(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode', { timeout: 12000 });
  await expect(page.locator('#premiumOutputButton')).toBeVisible();
  await expect(page.locator('#trackInfoButton')).toBeVisible();
  await expect(page.locator('#desktopMiniQueue')).toBeVisible();
}

async function assertNoHorizontalOverflow(page) {
  const metrics = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    html: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(metrics.body).toBeLessThanOrEqual(metrics.inner + 1);
  expect(metrics.html).toBeLessThanOrEqual(metrics.inner + 1);
}

test('desktop premium experience renders and operates', async ({ page }) => {
  await openDemo(page, { width: 1440, height: 1000 });

  await expect(page.locator('#playerCard')).toBeVisible();
  await expect(page.locator('#desktopMiniQueue')).toBeVisible();
  await expect(page.locator('#recentSection')).toBeVisible();

  await page.locator('#premiumOutputButton').click();
  await expect(page.locator('#multiroomSheet')).toHaveClass(/open/);
  await page.locator('.multiroom-close').click();

  await page.locator('.album-info-button').first().click();
  await expect(page.locator('#albumDetailDialog')).toBeVisible();
  await expect(page.locator('[data-album-action="play"]')).toBeVisible();
  await expect(page.locator('[data-album-action="shuffle"]')).toBeVisible();
  await page.locator('.album-dialog-close').click();

  await page.locator('#playerArt').click();
  await expect(page.locator('#fullscreenNowPlaying')).toBeVisible();
  await expect(page.locator('.fullscreen-controls')).toBeVisible();
  await expect(page.locator('#fullscreenOutputButton')).toBeVisible();
  await page.locator('.fullscreen-close').click();

  await assertNoHorizontalOverflow(page);
  await page.screenshot({ path: 'test-results/desktop-premium.png', fullPage: true });
});

test('mobile premium experience fits and keeps controls reachable', async ({ page }) => {
  await openDemo(page, { width: 390, height: 844 });

  await expect(page.locator('.mobile-nav')).toBeVisible();
  await expect(page.locator('#mobileMiniPlayer')).toBeVisible();

  const nav = page.locator('.mobile-nav');
  const navBox = await nav.boundingBox();
  expect(navBox.x).toBeGreaterThanOrEqual(-1);
  expect(navBox.x + navBox.width).toBeLessThanOrEqual(391);

  await page.locator('.mobile-nav [data-nav="library"]').click();
  await expect(page.locator('.mobile-nav [data-nav="library"]')).toHaveClass(/active/);

  await page.locator('.album-info-button').first().click();
  await expect(page.locator('#albumDetailDialog')).toBeVisible();
  const albumBox = await page.locator('#albumDetailDialog .premium-dialog-inner').boundingBox();
  expect(albumBox.width).toBeLessThanOrEqual(390);
  expect(albumBox.height).toBeLessThanOrEqual(844);
  await page.locator('.album-dialog-close').click();

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

  // .volume-output-row stacks below 620px, so any visible unstyled child can
  // stretch to the full row width. Optional controls may exist but be hidden in
  // radio mode, so only measure controls that actually participate in layout.
  for (const selector of ['#sleepButton', '#muteButton', '.dock-heart']) {
    const control = page.locator(selector).first();
    if ((await control.count()) === 0 || !(await control.isVisible())) continue;
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
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

  await page.screenshot({ path: 'test-results/mobile-radio.png', fullPage: true });
});

test('an album cover that fails to load falls back to the record placeholder', async ({ page }) => {
  await openDemo(page, { width: 1280, height: 900 });
  const first = page.locator('.album-card').first();
  const img = first.locator('.album-art-img');
  await expect(img).toBeAttached();
  await img.evaluate(node => {
    node.src = '/definitely-missing-cover.jpg';
  });
  await expect(first.locator('.album-art-placeholder')).toBeVisible();
});

test('the album density slider has four stops and remembers the choice', async ({ page }) => {
  await openDemo(page, { width: 1280, height: 900 });
  const slider = page.locator('#albumDensity');
  await expect(slider).toBeVisible();
  await expect(slider).toHaveAttribute('min', '0');
  await expect(slider).toHaveAttribute('max', '3');
  await expect(slider).toHaveAttribute('step', '1');

  await slider.fill('3');
  await expect(page.locator('#albumDensityLabel')).toContainText('4 per row');
  await page.reload();
  await expect(page.locator('#albumDensity')).toHaveValue('3');
});
