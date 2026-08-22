const { test, expect } = require('@playwright/test');

async function openDemo(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode', { timeout: 12000 });
}

async function enterLiveStreamWhileBrowsingMusic(page) {
  await page.evaluate(async () => {
    await window.OWNTONE_APP.playUri('library:playlist:11');
    window.OWNTONE_APP.state.player.item_progress_ms = 1272000;
    window.OWNTONE_APP.state.player.item_length_ms = 1272000;
    document.getElementById('modeToggle').click();
  });
  await expect(page.locator('body')).not.toHaveClass(/radio-mode/);
  await expect(page.locator('#playerCard')).toHaveClass(/is-live-current/);
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 375, height: 812 },
]) {
  test(`live stream uses semantic status instead of fake song progress at ${viewport.width}px`, async ({ page }) => {
    await openDemo(page, viewport);
    await enterLiveStreamWhileBrowsingMusic(page);

    await expect(page.locator('#playerKicker')).toHaveText('LIVE NOW');
    await expect(page.locator('#progressBlock')).toHaveClass(/is-live-stream/);
    await expect(page.locator('#progressRange')).toBeHidden();
    await expect(page.locator('.time-row')).toBeHidden();
    await expect(page.locator('#liveStreamStatus')).toBeVisible();
    await expect(page.locator('#liveStreamStatus')).toContainText('LIVE STREAM');
    await expect(page.locator('#liveStreamSession')).toHaveText('Connected 21:12');
    await expect(page.locator('#playingFrom b')).toHaveText('KEXP 90.3');
    await expect(page.locator('#remainingTime')).toBeHidden();

    const geometry = await page.evaluate(() => {
      const card = document.querySelector('#playerCard').getBoundingClientRect();
      const status = document.querySelector('#liveStreamStatus').getBoundingClientRect();
      return {
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        cardTop: card.top,
        cardBottom: card.bottom,
        statusTop: status.top,
        statusBottom: status.bottom,
      };
    });

    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
    expect(geometry.statusTop).toBeGreaterThanOrEqual(geometry.cardTop);
    expect(geometry.statusBottom).toBeLessThanOrEqual(geometry.cardBottom - 2);
  });
}

test('finite music track keeps normal elapsed and remaining controls', async ({ page }) => {
  await openDemo(page, { width: 1280, height: 800 });
  await expect(page.locator('#playerCard')).not.toHaveClass(/is-live-current/);
  await expect(page.locator('#progressRange')).toBeVisible();
  await expect(page.locator('.time-row')).toBeVisible();
  await expect(page.locator('#elapsedTime')).toBeVisible();
  await expect(page.locator('#remainingTime')).toBeVisible();
  await expect(page.locator('#liveStreamStatus')).toBeHidden();
});
