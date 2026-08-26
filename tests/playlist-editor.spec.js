const { test, expect } = require('@playwright/test');

/**
 * The editor shortened every line over 58 characters for display and then read
 * the lines back out of those same text nodes when saving — so pressing Save
 * rewrote each long path as its own truncated prefix, and the server accepted
 * it. A typical library path is well past 58 characters, so this destroyed
 * ordinary playlists on the first save.
 */

const LONG_PATH = '/media/music/Music/Massive Attack/Mezzanine/03 Teardrop.flac';
const LONG_URL = 'https://stream.example.com/very/long/path/to/a/station/endpoint/live.mp3';
const SHORT = '/media/music/a.flac';

/** Serve the companion's playlist endpoints and capture what Save sends. */
async function stubCompanion(page) {
  await page.evaluate(
    ([longPath, longUrl, short]) => {
      window.__saved = null;
      const real = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : String(input?.url || '');
        const method = String(init.method || 'GET').toUpperCase();
        const json = body =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });

        if (url.includes('/scheduler/playlists')) {
          if (method === 'PUT') {
            window.__saved = JSON.parse(init.body);
            return json({ ok: true, track_count: window.__saved.lines.length });
          }
          return json({
            items: [
              {
                slug: 'mixtape',
                name: 'Mixtape',
                file: 'mixtape.m3u',
                track_count: 3,
                lines: [longPath, longUrl, short],
              },
            ],
            dir: '/media/music/Playlists',
          });
        }
        return real(input, init);
      };
    },
    [LONG_PATH, LONG_URL, SHORT]
  );
}

async function openEditor(page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode', { timeout: 12000 });
  await stubCompanion(page);
  await page.locator('#managePlaylists').click();
  await page.locator('.playlist-pick[data-slug="mixtape"]').click();
  await expect(page.locator('#plineList .pline')).toHaveCount(3);
}

test('saving a playlist keeps every line intact', async ({ page }) => {
  await openEditor(page);
  await page.locator('#plineSave').click();
  await expect.poll(() => page.evaluate(() => window.__saved)).not.toBeNull();

  expect(await page.evaluate(() => window.__saved.lines)).toEqual([LONG_PATH, LONG_URL, SHORT]);
});

test('reordering keeps the full line, not the shortened label', async ({ page }) => {
  await openEditor(page);
  // Move the long URL up past the long path; both are over the old 58-char cut.
  await page.locator('#plineList .pline').nth(1).locator('[data-up]').click();
  await page.locator('#plineSave').click();
  await expect.poll(() => page.evaluate(() => window.__saved)).not.toBeNull();

  expect(await page.evaluate(() => window.__saved.lines)).toEqual([LONG_URL, LONG_PATH, SHORT]);
});

test('removing a line leaves the survivors whole', async ({ page }) => {
  await openEditor(page);
  await page.locator('#plineList .pline').nth(2).locator('[data-del]').click();
  await page.locator('#plineSave').click();
  await expect.poll(() => page.evaluate(() => window.__saved)).not.toBeNull();

  expect(await page.evaluate(() => window.__saved.lines)).toEqual([LONG_PATH, LONG_URL]);
});
