const { test, expect } = require('@playwright/test');

async function openDemo(page) {
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode');
  await expect(page.locator('#fullscreenVolumeRange')).toBeAttached();
}

test('player events publish a completed render and keep dependent controls in sync', async ({ page }) => {
  await openDemo(page);
  const snapshots = await page.evaluate(async () => {
    const snapshots = [];
    const off = window.OwnTone.on('owntone:player-updated', () => {
      snapshots.push({
        stateTitle: window.OWNTONE_APP.state.current.title,
        renderedTitle: document.getElementById('trackTitle').textContent,
      });
    });
    await window.OWNTONE_APP.playUri('library:album:0');
    off();
    return snapshots;
  });
  expect(snapshots.length).toBeGreaterThan(0);
  expect(snapshots.every(item => item.stateTitle === item.renderedTitle)).toBe(true);
  await expect(page.locator('.mobile-mini-copy b')).toHaveText('Dummy');
  await page.locator('#playerArt').click();
  await expect(page.locator('#fullscreenTitle')).toHaveText('Dummy');
  await page.locator('#playButton').evaluate(button => button.click());
  await expect(page.locator('.fullscreen-play')).toHaveAttribute('aria-label', 'Play');
});

test('closed fullscreen stays idle and catches up when opened', async ({ page }) => {
  await openDemo(page);
  const mutations = await page.evaluate(async () => {
    const dialog = document.getElementById('fullscreenNowPlaying');
    let count = 0;
    const observer = new MutationObserver(records => {
      count += records.length;
    });
    observer.observe(dialog, { subtree: true, childList: true, characterData: true, attributes: true });
    await window.OWNTONE_APP.playerCommand('next');
    count += observer.takeRecords().length;
    observer.disconnect();
    return count;
  });
  expect(mutations).toBe(0);
  await page.locator('#playerArt').click();
  await expect(page.locator('#fullscreenTitle')).toHaveText('Riders on the Storm');
});

test('independent premium refreshes preserve the multi-room output label', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(async () => {
    const app = window.OWNTONE_APP;
    await app.selectPhysicalOutputs(app.state.outputs.slice(0, 2).map(output => output.id));
    await window.OWNTONE_APP.playerCommand('toggle');
  });
  await expect(page.locator('#premiumOutputButton b')).toHaveText('2 outputs');
  await page.evaluate(() => window.OwnTone.emit('owntone:artwork-updated'));
  await expect(page.locator('#premiumOutputButton b')).toHaveText('2 outputs');
  await page.locator('#playerArt').click();
  await expect(page.locator('#fullscreenOutputName')).toHaveText('2 outputs');
});

test('context enhancement scans additions and does not rescan the library for unrelated DOM changes', async ({
  page,
}) => {
  await openDemo(page);
  await page.evaluate(() => {
    const original = document.querySelectorAll.bind(document);
    window.__contextScans = 0;
    document.querySelectorAll = selector => {
      if (selector.includes('.album-track-row[data-context-uri]')) window.__contextScans++;
      return original(selector);
    };
    const unrelated = document.createElement('div');
    unrelated.innerHTML = '<b>Unrelated status</b>';
    document.body.appendChild(unrelated);
  });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__contextScans)).toBe(0);
  await page.evaluate(() => {
    const album = document.createElement('article');
    album.id = 'newArchitectureAlbum';
    album.className = 'album-card';
    album.dataset.uri = 'library:album:99';
    album.innerHTML = '<div class="album-copy"><b>New album</b></div>';
    document.getElementById('albumGrid').appendChild(album);
  });
  await expect(page.locator('#newArchitectureAlbum > .context-menu-trigger')).toHaveCount(1);
  expect(await page.evaluate(() => window.__contextScans)).toBe(0);
});
