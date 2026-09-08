const { test, expect } = require('@playwright/test');
const { exposeMutableState } = require('./helpers/app-state');
test.beforeEach(async ({ page }) => exposeMutableState(page));

async function openDemo(page) {
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode');
  await expect(page.locator('#premiumOutputButton')).toBeVisible();
}

for (const replacement of ['new', '']) {
  test(`late search results cannot overwrite ${replacement || 'cleared'} input`, async ({ page }) => {
    await openDemo(page);
    await page.evaluate(() => {
      window.__testState.demo = false;
      const original = window.fetch;
      window.fetch = async (input, init) => {
        const url = new URL(input, location.href);
        if (url.pathname !== '/api/search') return original(input, init);
        const query = url.searchParams.get('query');
        if (query === 'old') {
          await new Promise(resolve => {
            window.__releaseOldSearch = resolve;
          });
        }
        return new Response(
          JSON.stringify({
            tracks: { items: [{ title: `${query} result`, uri: `library:track:${query}` }] },
          }),
          { status: 200 }
        );
      };
    });
    await page.locator('#searchButton').click();
    await page.locator('#searchInput').fill('old');
    await expect.poll(() => page.evaluate(() => Boolean(window.__releaseOldSearch))).toBe(true);
    await page.locator('#searchInput').fill(replacement);
    const expected = replacement ? 'new result' : 'Start typing';
    await expect(page.locator('#searchResults')).toContainText(expected);
    await page.evaluate(() => window.__releaseOldSearch());
    await page.waitForTimeout(200);
    await expect(page.locator('#searchResults')).toContainText(expected);
    await expect(page.locator('#searchResults')).not.toContainText('old result');
  });
}

test('background tabs stop player, history, queue and radio health requests', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.__testState.demo = false;
    window.__backgroundCalls = [];
    const original = window.fetch;
    window.fetch = async (input, init) => {
      window.__backgroundCalls.push(String(input));
      return original(input, init);
    };
  });
  await page.waitForTimeout(9500);
  const calls = await page.evaluate(() => window.__backgroundCalls);
  expect(
    calls.filter(url => /\/api\/(player|queue|outputs)|\/scheduler\/(history|radio-health)/.test(url))
  ).toEqual([]);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect
    .poll(() => page.evaluate(() => window.__backgroundCalls.some(url => url.endsWith('/api/player'))))
    .toBe(true);
});

test('a pending favorite save cannot duplicate writes or favorite the next track', async ({ page }) => {
  await openDemo(page);
  const playlist = { slug: 'favorites', name: 'Favorites', lines: [] };
  const writes = [];
  let releaseSave;
  await page.route('**/scheduler/playlists**', async route => {
    if (route.request().method() === 'PUT') {
      writes.push(route.request().postDataJSON());
      await new Promise(resolve => {
        releaseSave = resolve;
      });
      playlist.lines = writes.at(-1).lines;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { items: [playlist] } });
  });
  await page.evaluate(() => {
    window.__testState.demo = false;
    window.__testState.current = {
      id: 'track-a',
      path: '/music/a.flac',
      title: 'Track A',
      data_kind: 'file',
    };
    const button = document.querySelector('.dock-heart');
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await expect.poll(() => writes.length).toBe(1);
  await page.evaluate(() => {
    window.__testState.current = {
      id: 'track-b',
      path: '/music/b.flac',
      title: 'Track B',
      data_kind: 'file',
    };
  });
  await page.waitForTimeout(1200);
  releaseSave();
  await expect(page.locator('.dock-heart')).toBeEnabled();
  await expect(page.locator('.dock-heart')).toHaveAttribute('aria-pressed', 'false');
  expect(writes).toEqual([{ lines: ['/music/a.flac'] }]);
});
