const { test, expect } = require('@playwright/test');

/**
 * shortcuts.js listens on `document`, so every key it claims is claimed for the
 * whole page. Two things went wrong at once and neither had a test:
 *
 *  - Space calls preventDefault(), which is also how a <button> activates from
 *    the keyboard. Every button in the dashboard stopped responding to Space.
 *  - app.js handles Space on a focused .radio-card. Both handlers ran, so one
 *    keystroke started the station and then toggled the player.
 */

async function openDemo(page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode', { timeout: 12000 });
}

/** Count clicks that actually reach a button, whatever key produced them. */
async function watchClicks(page, selector) {
  await page.evaluate(sel => {
    window.__clicks = 0;
    document.querySelector(sel).addEventListener('click', () => (window.__clicks += 1));
  }, selector);
}

test('Space activates an ordinary button instead of toggling playback', async ({ page }) => {
  await openDemo(page);
  await watchClicks(page, '#refreshButton');

  await page.locator('#refreshButton').focus();
  await page.keyboard.press(' ');

  expect(await page.evaluate(() => window.__clicks)).toBe(1);
});

test('Space on the play button toggles once, not twice', async ({ page }) => {
  await openDemo(page);
  await watchClicks(page, '#playButton');
  const state = () => page.evaluate(() => window.OWNTONE_APP.state.player.state);
  expect(await state()).toBe('play');

  await page.locator('#playButton').focus();
  await page.keyboard.press(' ');
  await page.waitForTimeout(200);

  // One click reaches the button, and the state flips exactly once. A second
  // toggle from the global shortcut would land back on 'play'.
  expect(await page.evaluate(() => window.__clicks)).toBe(1);
  expect(await state()).toBe('pause');
});

test('Space on a radio card starts the station without toggling the player', async ({ page }) => {
  await openDemo(page);
  await page.locator('#modeToggle').click();
  const card = page.locator('.radio-card[data-uri]').first();
  await expect(card).toBeVisible();

  await page.evaluate(() => {
    window.__toggles = 0;
    window.__played = [];
    const app = window.OWNTONE_APP;
    const originalCommand = app.playerCommand;
    app.playerCommand = command => {
      if (command === 'toggle') window.__toggles += 1;
      return originalCommand(command);
    };
    const originalPlay = app.playUri;
    app.playUri = uri => {
      window.__played.push(uri);
      return originalPlay(uri);
    };
  });

  await card.focus();
  await page.keyboard.press(' ');
  await page.waitForTimeout(300);

  expect(await page.evaluate(() => window.__toggles)).toBe(0);
  expect(await page.evaluate(() => window.OWNTONE_APP.state.player.state)).toBe('play');
});

test('typing keys still reach text inputs', async ({ page }) => {
  await openDemo(page);
  await page.locator('#searchButton').click();
  const input = page.locator('#searchInput');
  await input.fill('');
  await input.type('kind of blue');
  await expect(input).toHaveValue('kind of blue');
});
