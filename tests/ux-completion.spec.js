const { test, expect } = require('@playwright/test');

async function openDemo(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode', { timeout: 12000 });
  await expect(page.locator('script[data-owntone-script="ux-completion.js"]')).toBeAttached();
}

test('mobile navigation stays at five primary items and mini player opens fullscreen', async ({ page }) => {
  await openDemo(page, { width: 390, height: 844 });
  await expect(page.locator('.mobile-nav > button')).toHaveCount(5);
  await expect(page.locator('#muteNavButton')).toHaveCount(0);

  await page.evaluate(() => window.scrollTo(0, 900));
  await expect(page.locator('#mobileMiniPlayer')).toHaveClass(/visible/);
  await page.locator('#mobileMiniPlayer .mobile-mini-copy').click();
  await expect(page.locator('#fullscreenNowPlaying')).toBeVisible();
  await expect(page.locator('#fullscreenVolumeRange')).toBeVisible();
  await expect(page.locator('#fullscreenQueueButton')).toBeVisible();
  await expect(page.locator('#fullscreenFavoriteButton')).toBeVisible();
  await expect(page.locator('#fullscreenTrackActionsButton')).toBeVisible();
});

test('favorites control toggles the current demo track instead of playing Favorites playlist', async ({
  page,
}) => {
  await openDemo(page, { width: 1280, height: 800 });
  const favorite = page.locator('.transport-row .current-favorite-control');
  await expect(favorite).toBeVisible();
  await expect(favorite).not.toHaveAttribute('data-action', /.+/);
  await favorite.click();
  await expect(favorite).toHaveClass(/is-current-favorite/);
  await expect(favorite).toHaveAttribute('aria-pressed', 'true');
});

test('desktop now playing exposes current track actions', async ({ page }) => {
  await openDemo(page, { width: 1280, height: 800 });
  const actions = page.locator('#trackActionsButton');
  await expect(actions).toBeVisible();
  await actions.click();
  await expect(page.locator('#uxTrackActionsDialog')).toBeVisible();
  await expect(page.locator('#uxTrackPlaylist')).toBeVisible();
});

test('sidebar has one History destination plus Browse and Insights', async ({ page }) => {
  await openDemo(page, { width: 1280, height: 800 });
  await expect(page.locator('[data-nav="recent"]')).toHaveCount(0);
  await expect(page.locator('#historyNavButton')).toContainText('History');
  await expect(page.locator('#browseNavButton')).toBeVisible();
  await expect(page.locator('#insightsNavButton')).toBeVisible();
});

test('manager dialogs get explicit close buttons', async ({ page }) => {
  await openDemo(page, { width: 1280, height: 800 });
  await page.locator('#managePlaylists').click();
  await expect(page.locator('#playlistsDialog')).toBeVisible();
  await expect(page.locator('#playlistsDialog .ux-manager-close')).toBeVisible();
  await page.locator('#playlistsDialog .ux-manager-close').click();
  await expect(page.locator('#playlistsDialog')).not.toBeVisible();

  await page.locator('#modeToggle').click();
  await page.locator('#manageStations').click();
  await expect(page.locator('#stationsDialog')).toBeVisible();
  await expect(page.locator('#stationsDialog .ux-manager-close')).toBeVisible();
});

test('destructive manager action requires a second click', async ({ page }) => {
  await openDemo(page, { width: 1280, height: 800 });
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'deleteProbe';
    button.className = 'station-del';
    button.type = 'button';
    document.body.appendChild(button);
  });
  const probe = page.locator('#deleteProbe');
  await probe.click();
  await expect(probe).toHaveClass(/delete-armed/);
});

test('cards with secondary controls are no longer nested interactive buttons', async ({ page }) => {
  await openDemo(page, { width: 1280, height: 800 });
  const album = page.locator('.album-card[data-uri]').first();
  await expect(album.locator('.context-menu-trigger')).toBeAttached();
  await expect(album).toHaveAttribute('role', 'button');
  expect(await album.evaluate(node => node.tagName)).toBe('DIV');
});

test('mobile More opens consolidated dashboard actions', async ({ page }) => {
  await openDemo(page, { width: 390, height: 844 });
  await expect(page.locator('#dockMoreButton')).toBeVisible();
  await page.locator('#dockMoreButton').click();
  await expect(page.locator('#uxMoreDialog')).toBeVisible();
  await expect(page.locator('[data-ux-more="queue"]')).toBeVisible();
  await expect(page.locator('[data-ux-more="history"]')).toBeVisible();
  await expect(page.locator('[data-ux-more="browse"]')).toBeVisible();
  await expect(page.locator('[data-ux-more="insights"]')).toBeVisible();
});
