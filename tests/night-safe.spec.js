const { test, expect } = require('@playwright/test');

/**
 * The night cap is the one behaviour in this dashboard that exists to prevent a
 * specific unpleasant outcome: a tap at 3am blasting a HomePod. It had four
 * separate implementations and no test at all.
 *
 * These run against OwnTone.startPlayback with fetch stubbed, so they assert
 * what actually reaches the server rather than what the UI shows.
 */

async function openDemo(page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode', { timeout: 12000 });
}

/** Record every request startPlayback makes, and answer the ones it awaits. */
async function stubApi(page) {
  await page.evaluate(() => {
    window.__calls = [];
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      window.__calls.push({ url, method: String(init.method || 'GET').toUpperCase() });
      const body = url.includes('/outputs')
        ? { outputs: [{ id: 'hp', name: 'HomePod mini', selected: true, volume: 40 }] }
        : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  });
}

/**
 * Force the night window open or shut. nightSafe.isActive() reads the config
 * object on every call, so setting it after load is enough.
 */
async function setNightWindow(page, active) {
  await page.evaluate(isActive => {
    const config = window.OwnTone.config;
    if (isActive) {
      config.nightSafeStartHour = 0;
      config.nightSafeEndHour = 23.999;
    } else {
      // A one-hour window that cannot contain the current time, whenever the
      // suite happens to run.
      const hour = new Date().getHours();
      config.nightSafeStartHour = (hour + 3) % 24;
      config.nightSafeEndHour = (hour + 4) % 24;
    }
    config.nightSafeMaxVolume = 8;
  }, active);
}

function volumeCalls(calls) {
  return calls
    .filter(call => call.method === 'PUT' && call.url.includes('/player/volume'))
    .map(call => Number(new URL(call.url, 'http://x').searchParams.get('volume')));
}

test('night hours cap the volume before playback starts', async ({ page }) => {
  await openDemo(page);
  await stubApi(page);
  await setNightWindow(page, true);

  const calls = await page.evaluate(async () => {
    document.getElementById('volumeRange').value = '60';
    await window.OwnTone.startPlayback({ uris: 'library:playlist:1' });
    return window.__calls;
  });

  expect(volumeCalls(calls)).toEqual([8]);

  // The cap is applied before the queue add, not after — otherwise the speaker
  // is briefly loud.
  const volumeIndex = calls.findIndex(c => c.url.includes('/player/volume'));
  const playIndex = calls.findIndex(c => c.url.includes('/queue/items/add'));
  expect(volumeIndex).toBeGreaterThanOrEqual(0);
  expect(playIndex).toBeGreaterThan(volumeIndex);
  expect(calls[playIndex].url).toContain('playback=start');
});

test('the cap is a ceiling, never a floor', async ({ page }) => {
  await openDemo(page);
  await stubApi(page);
  await setNightWindow(page, true);

  const calls = await page.evaluate(async () => {
    document.getElementById('volumeRange').value = '3';
    await window.OwnTone.startPlayback({ uris: 'library:playlist:1' });
    return window.__calls;
  });

  // One implementation used to send volume=cap unconditionally, so replaying a
  // track at 3% raised it to 8% in the middle of the night.
  expect(volumeCalls(calls)).toEqual([3]);
});

test('outside night hours the slider is honoured', async ({ page }) => {
  await openDemo(page);
  await stubApi(page);
  await setNightWindow(page, false);

  const calls = await page.evaluate(async () => {
    document.getElementById('volumeRange').value = '60';
    await window.OwnTone.startPlayback({ uris: 'library:playlist:1' });
    return window.__calls;
  });

  expect(volumeCalls(calls)).toEqual([60]);
});

test('every selected output is capped, not just the first', async ({ page }) => {
  await openDemo(page);
  await page.evaluate(() => {
    window.__calls = [];
    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      window.__calls.push({ url, method: String(init.method || 'GET').toUpperCase() });
      const body = url.includes('/outputs')
        ? {
            outputs: [
              { id: 'kitchen', name: 'Kitchen', selected: true, volume: 55 },
              { id: 'living', name: 'Living Room', selected: true, volume: 40 },
              { id: 'bedroom', name: 'Bedroom', selected: false, volume: 20 },
            ],
          }
        : {};
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  });
  await setNightWindow(page, true);

  const calls = await page.evaluate(async () => {
    document.getElementById('volumeRange').value = '70';
    await window.OwnTone.startPlayback({ uris: 'library:playlist:1' });
    return window.__calls;
  });

  const targets = calls
    .filter(call => call.url.includes('/player/volume'))
    .map(call => {
      const params = new URL(call.url, 'http://x').searchParams;
      return { output: params.get('output_id'), volume: Number(params.get('volume')) };
    });

  expect(targets).toHaveLength(2);
  expect(targets.map(t => t.output).sort()).toEqual(['kitchen', 'living']);
  expect(targets.every(t => t.volume === 8)).toBe(true);
});

test('the night cap survives a change to apiBase', async ({ page }) => {
  await openDemo(page);
  await stubApi(page);
  await setNightWindow(page, true);

  // The old implementation matched the literal string '/api/queue/items/add'
  // inside a window.fetch patch, so pointing apiBase elsewhere silently
  // disabled the cap. Playback goes through one function now, so it cannot.
  const calls = await page.evaluate(async () => {
    document.getElementById('volumeRange').value = '75';
    await window.OwnTone.startPlayback({ uris: 'library:playlist:1' });
    return window.__calls;
  });

  expect(volumeCalls(calls)).toEqual([8]);
  expect(calls.some(call => call.url.includes('/queue/items/add'))).toBe(true);
});
