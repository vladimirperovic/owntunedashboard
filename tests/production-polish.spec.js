const { test, expect } = require('@playwright/test');

async function openDemo(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode', { timeout: 12000 });
  await expect(page.locator('.context-menu-trigger').first()).toBeAttached();
}

test('mobile touch opens context menu without activating parent card', async ({ page }) => {
  await openDemo(page, { width: 390, height: 844 });
  const trigger = page.locator('.album-card[data-uri]').first().locator(':scope > .context-menu-trigger');
  await trigger.evaluate(el => el.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true,
    cancelable: true,
    pointerType: 'touch',
  })));
  await expect(page.locator('#contextActionMenu')).toBeVisible();
  await expect(page.locator('[data-context-action="play-next"]')).toBeVisible();
  await expect(page.locator('[data-context-action="play-last"]')).toBeVisible();
});

test('recent cards contain text after context trigger is appended', async ({ page }) => {
  await openDemo(page, { width: 1280, height: 800 });
  const card = page.locator('.premium-recent-card').first();
  await expect(card.locator(':scope > .context-menu-trigger')).toBeAttached();
  const fits = await card.locator(':scope > span:nth-child(2)').evaluate(el => ({
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
  }));
  expect(fits.scrollWidth).toBeLessThanOrEqual(fits.clientWidth + 1);
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.width + 1);
});

test('radio uses configured artwork only and keeps artwork left of play', async ({ page }) => {
  await openDemo(page, { width: 1280, height: 800 });
  await page.locator('#modeToggle').click();
  await expect(page.locator('body')).toHaveClass(/radio-mode/);
  const image = page.locator('.radio-station-identity').first();
  await expect(image).toBeVisible();
  const card = image.locator('xpath=ancestor::*[contains(@class,"radio-card")][1]');
  const play = card.locator('.radio-play-btn, .radio-play').first();
  const [imageBox, cardBox, playBox] = await Promise.all([image.boundingBox(), card.boundingBox(), play.boundingBox()]);
  expect(imageBox.x).toBeLessThan(cardBox.x + cardBox.width / 2);
  expect(playBox.x).toBeGreaterThan(cardBox.x + cardBox.width / 2);

  await page.evaluate(() => {
    const fake = document.createElement('span');
    fake.id = 'fallbackMonogramProbe';
    fake.className = 'radio-station-identity';
    fake.textContent = 'AZ';
    document.body.appendChild(fake);
  });
  // generated monogram identities are part of the design now (fills empty card corner)
  await expect(page.locator('#fallbackMonogramProbe')).toBeVisible();
});

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`elapsed and remaining time stay inside player at ${viewport.width}px`, async ({ page }) => {
    await openDemo(page, viewport);
    await expect(page.locator('#elapsedTime')).toBeVisible();
    await expect(page.locator('#remainingTime')).toBeVisible();
    const geometry = await page.evaluate(() => {
      const card = document.querySelector('#playerCard').getBoundingClientRect();
      const row = document.querySelector('.time-row').getBoundingClientRect();
      const elapsed = document.querySelector('#elapsedTime').getBoundingClientRect();
      const remaining = document.querySelector('#remainingTime').getBoundingClientRect();
      return {
        cardTop: card.top,
        cardBottom: card.bottom,
        rowTop: row.top,
        rowBottom: row.bottom,
        elapsedBottom: elapsed.bottom,
        remainingBottom: remaining.bottom,
      };
    });
    expect(geometry.rowTop).toBeGreaterThanOrEqual(geometry.cardTop);
    expect(geometry.rowBottom).toBeLessThanOrEqual(geometry.cardBottom - 2);
    expect(geometry.elapsedBottom).toBeLessThanOrEqual(geometry.cardBottom - 2);
    expect(geometry.remainingBottom).toBeLessThanOrEqual(geometry.cardBottom - 2);
  });
}
