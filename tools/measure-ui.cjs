// Run against the local test server: PORT=4184 node tests/static-server.js
// Counts DOM observer callbacks, not production CPU time or network latency.
const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
    });
    await page.addInitScript(() => {
      const OriginalObserver = window.MutationObserver;
      window.__observerCounts = {};
      window.MutationObserver = class extends OriginalObserver {
        constructor(callback) {
          const source = new Error().stack?.match(/\/(\w[\w-]*\.js)(?:\?|:)/)?.[1] || 'unknown';
          super((records, observer) => {
            window.__observerCounts[source] = (window.__observerCounts[source] || 0) + 1;
            callback(records, observer);
          });
        }
      };
    });
    await page.goto(process.argv[2] || 'http://127.0.0.1:4184/');
    await page.waitForFunction(
      () => window.OWNTONE_APP?.state.demo && document.getElementById('fullscreenVolumeRange')
    );
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      window.__observerCounts = {};
    });
    await page.waitForTimeout(3000);
    const idle = await page.evaluate(() => window.__observerCounts);
    await page.evaluate(() => {
      window.__observerCounts = {};
    });
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.OWNTONE_APP.playerCommand('toggle'));
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(200);
    const toggles = await page.evaluate(() => window.__observerCounts);
    console.log(JSON.stringify({ idle3Seconds: idle, tenPlaybackChanges: toggles }, null, 2));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
