const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// Load only the owned feature under test. Every request is an in-memory stub;
// the page route also blocks network access outside this local fixture.
async function fixture(page) {
  await page.route('**/*', route => {
    if (new URL(route.request().url()).pathname === '/audit-features-fixture') {
      return route.fulfill({
        contentType: 'text/html',
        body: `<div class="top-actions"></div><button id="refreshButton">Refresh</button>
          <div class="radio-intro"></div><div class="audio-dock"><div class="volume-output-row"></div></div>
          <nav class="side-nav"><button class="side-link">Albums</button></nav><nav class="mobile-nav"></nav>
          <section id="browseSection"></section><button id="premiumOutputButton"><b>Output</b></button>
          <span id="outputName"></span><div id="toast"></div>`,
      });
    }
    return route.abort();
  });
  await page.goto('/audit-features-fixture');
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '..', 'shared.js'), 'utf8') });
  await page.evaluate(() => {
    window.__calls = [];
    window.__responses = {};
    window.__hold = {};
    window.__pending = [];
    window.__fail = {};
    window.__toasts = [];
    window.__hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__hidden });
    window.__request = (url, options = {}) => {
      const method = options.method || 'GET';
      const key = `${method} ${url}`;
      window.__onRequest?.(url, options);
      window.__calls.push({ url, method, body: options.body ? JSON.parse(options.body) : null });
      if (window.__hold[key]) {
        return new Promise((resolve, reject) => window.__pending.push({ key, resolve, reject }));
      }
      if (window.__fail[key]) return Promise.reject(new Error(window.__fail[key]));
      return Promise.resolve(structuredClone(window.__responses[key] ?? {}));
    };
    window.OwnTone.api = window.__request;
    window.OwnTone.scheduler = window.__request;
    window.OwnTone.toast = text => window.__toasts.push(text);
    window.OwnTone.whenReady = callback => callback({ detail: { demo: false } });
    window.OwnTone.startPlayback = options =>
      window.__request('/mock-start', { method: 'POST', body: JSON.stringify(options) });
    window.OWNTONE_APP = {
      state: {
        online: true,
        demo: false,
        outputs: [{ id: 'speaker', name: 'Speaker', selected: true, volume: 20 }],
      },
      selectPhysicalOutputs: ids =>
        window.__request('/outputs/set', {
          method: 'PUT',
          body: JSON.stringify({ outputs: ids.map(String) }),
        }),
      setPhysicalOutputVolume: (id, volume) =>
        window.__request(`/outputs/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ volume }),
        }),
      refreshPlayback: async () => {},
      refreshLibrary: async () => {},
    };
  });
}

async function load(page, file) {
  await page.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '..', file), 'utf8') });
}

async function calls(page, method, url) {
  return page.evaluate(
    ([method, url]) => window.__calls.filter(call => call.method === method && call.url === url),
    [method, url]
  );
}

const playlists = [
  {
    slug: 'a',
    name: 'A',
    file: 'a.m3u',
    track_count: 2,
    lines: [
      '/music/first.flac',
      'https://example.invalid/a/very/long/stream/path/that/must/not/be/truncated.mp3',
    ],
  },
  { slug: 'b', name: 'B', file: 'b.m3u', track_count: 1, lines: ['/music/other.flac'] },
];

async function playlistFixture(page) {
  await fixture(page);
  await page.evaluate(items => {
    window.__responses['GET /playlists'] = { items };
  }, playlists);
  await load(page, 'playlist-editor.js');
  await page.locator('#managePlaylists').click();
}

test('playlist line edits keep one mutation handler and preserve full paths', async ({ page }) => {
  await playlistFixture(page);
  await page.locator('[data-slug="a"]').click();
  await page.locator('[data-down="0"]').click();
  await page.locator('[data-up="1"]').click();
  await page.locator('#plineAddForm input').fill('/music/new.flac');
  await page.locator('#plineAddForm button').click();
  await page.locator('#plineSave').click();
  await expect.poll(() => calls(page, 'PUT', '/playlists/a')).toHaveLength(1);
  expect((await calls(page, 'PUT', '/playlists/a'))[0].body.lines).toEqual([
    ...playlists[0].lines,
    '/music/new.flac',
  ]);
  await expect(page.locator('#plineDelete')).toBeEnabled();
  await page.locator('#plineDelete').click();
  await expect.poll(() => calls(page, 'DELETE', '/playlists/a')).toHaveLength(1);
});

test('late playlist reads cannot replace the latest editor or expose stale lines for saving', async ({
  page,
}) => {
  await playlistFixture(page);
  await page.evaluate(() => {
    window.__hold['GET /playlists'] = true;
  });
  await page.locator('[data-slug="a"]').click();
  await page.locator('[data-slug="b"]').click();
  await expect(page.locator('#playlistsEditor')).toBeHidden();
  await page.evaluate(items => window.__pending[1].resolve({ items }), playlists);
  await expect(page.locator('#playlistsEditor h3')).toContainText('B');
  await page.evaluate(items => window.__pending[0].resolve({ items }), playlists);
  await expect(page.locator('#playlistsEditor h3')).toContainText('B');
  await page.evaluate(() => {
    window.__hold['GET /playlists'] = false;
  });
  await page.locator('#plineSave').click();
  await expect.poll(() => calls(page, 'PUT', '/playlists/b')).toHaveLength(1);
  expect((await calls(page, 'PUT', '/playlists/b'))[0].body.lines).toEqual(playlists[1].lines);
});

test('playlist counts are text and pending saves cannot submit twice or change targets', async ({ page }) => {
  await playlistFixture(page);
  await page.evaluate(() => {
    window.__responses['GET /playlists'].items[0].track_count = '<img class="injected" src=x>';
    window.__hold['PUT /playlists/a'] = true;
  });
  await page.locator('[data-slug="a"]').click();
  await expect(page.locator('.injected')).toHaveCount(0);
  await page.locator('#plineSave').evaluate(button => {
    button.click();
    button.click();
  });
  await expect.poll(() => calls(page, 'PUT', '/playlists/a')).toHaveLength(1);
  await expect(page.locator('[data-slug="b"]')).toBeDisabled();
  await page.evaluate(() => window.__pending[0].reject(new Error('Save refused')));
  await expect(page.locator('#playlistsMsg')).toHaveText('Save refused');
  await expect(page.locator('#plineSave')).toBeEnabled();
});

async function schedulerFixture(page) {
  await fixture(page);
  await page.evaluate(() => {
    window.__responses['GET /schedules'] = {
      items: [
        {
          id: 'rule',
          name: 'Morning',
          days: ['mon'],
          kind: 'radio',
          source_uri: 'radio:a',
          source_name: 'A',
          output_id: 'speaker',
          enabled: true,
          time: '09:00',
          volume: 20,
        },
      ],
    };
    window.__responses['GET /library/playlists?limit=500'] = {
      items: [
        { uri: 'radio:a', name: 'A', path: '/Radio/a.m3u' },
        { uri: 'radio:b', name: 'B', path: '/Radio/b.m3u' },
        { uri: 'playlist:mix', name: 'Mix', path: '/Playlists/mix.m3u' },
      ],
    };
    window.__responses['GET /outputs'] = { outputs: [{ id: 'speaker', name: 'Speaker', type: 'AirPlay' }] };
  });
  await load(page, 'scheduler-ui.js');
  await page.locator('#scheduleButton').click();
  await expect(page.locator('#scheduleMessage')).toHaveText('');
}

test('scheduler refreshes fallback choices and rolls back rejected enabled switches', async ({ page }) => {
  await schedulerFixture(page);
  await page.locator('[data-edit="rule"]').click();
  await page.locator('#scheduleFallback').selectOption('radio:b');
  await page.locator('#scheduleSource').selectOption('radio:b');
  await expect(page.locator('#scheduleFallback')).toHaveValue('');
  await expect(page.locator('#scheduleFallback option[value="radio:b"]')).toHaveCount(0);
  await page.evaluate(() => {
    window.__fail['PUT /schedules/rule'] = 'Update refused';
  });
  await page.locator('[data-toggle="rule"]').click();
  await expect(page.locator('#scheduleMessage')).toHaveText('Update refused');
  await expect(page.locator('[data-toggle="rule"]')).toBeChecked();
  await expect(page.locator('[data-toggle="rule"]')).toBeEnabled();
});

test('scheduler escapes server numeric fields and submits a new schedule only once', async ({ page }) => {
  await schedulerFixture(page);
  await page.evaluate(() => {
    const item = window.__responses['GET /schedules'].items[0];
    item.volume = '<img class="injected" src=x>';
    item.ramp_minutes = '<img class="injected" src=x>';
    item.ramp_volume = '<img class="injected" src=x>';
    item.next_run = '2026-09-09T09:00:00Z';
    document.querySelector('#scheduleDialog').close();
  });
  await page.locator('#scheduleButton').click();
  await expect(page.locator('#scheduleSummary')).toContainText('<img');
  await expect(page.locator('.injected')).toHaveCount(0);
  await page.evaluate(() => {
    window.__hold['POST /schedules'] = true;
  });
  await page.locator('.schedule-save').evaluate(button => {
    button.click();
    button.click();
  });
  await expect.poll(() => calls(page, 'POST', '/schedules')).toHaveLength(1);
  await expect(page.locator('#scheduleReset')).toBeDisabled();
  await page.evaluate(() => window.__pending[0].reject(new Error('Save refused')));
  await expect(page.locator('.schedule-save')).toBeEnabled();
  await expect(page.locator('#scheduleMessage')).toHaveText('Save refused');
});

test('sleep status ignores stale polls, skips hidden tabs, and prevents overlapping reads', async ({
  page,
}) => {
  await fixture(page);
  await page.clock.install();
  await page.evaluate(() => {
    window.__hold['GET /sleep'] = true;
    window.__responses['POST /sleep'] = { active: true, remaining_min: 15 };
  });
  await load(page, 'sleep-timer.js');
  await page.clock.runFor(120000);
  expect(await calls(page, 'GET', '/sleep')).toHaveLength(1);
  await page.locator('#sleepButton').click();
  await page.locator('[data-min="15"]').click();
  await expect(page.locator('#sleepButton')).toHaveClass(/has-timer/);
  await page.evaluate(() => window.__pending[0].resolve({ active: false }));
  await expect(page.locator('#sleepStatus')).toContainText('15 min');
  await page.evaluate(() => {
    window.__hidden = true;
  });
  await page.clock.runFor(120000);
  expect(await calls(page, 'GET', '/sleep')).toHaveLength(1);
  await page.evaluate(() => {
    window.__hidden = false;
    window.__hold['GET /sleep'] = false;
    window.__responses['GET /sleep'] = { active: true, remaining_min: 0 };
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#sleepButton')).toHaveAttribute('title', 'Sleep timer: fading out');
  expect(await calls(page, 'GET', '/sleep')).toHaveLength(2);
});

test('station writes are guarded and delayed library refresh failures are handled', async ({ page }) => {
  await fixture(page);
  await page.clock.install();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    window.__hold['POST /stations'] = true;
    window.OWNTONE_APP.refreshLibrary = async () => {
      throw new Error('Offline');
    };
  });
  await load(page, 'station-manager.js');
  await page.locator('#manageStations').click();
  await page.locator('#stationName').fill('Station');
  await page.locator('#stationUrl').fill('https://example.invalid/stream');
  await page.locator('#stationForm button').evaluate(button => {
    button.click();
    button.click();
  });
  expect(await calls(page, 'POST', '/stations')).toHaveLength(1);
  await page.evaluate(() => window.__pending[0].resolve({ ok: true }));
  await expect(page.locator('#stationForm button')).toBeEnabled();
  await page.clock.runFor(4000);
  await expect
    .poll(() => page.evaluate(() => window.__toasts))
    .toContain('Station updated, but the library refresh failed');
  expect(errors).toEqual([]);
});

async function folderFixture(page) {
  await fixture(page);
  await page.evaluate(() => {
    window.OwnTone.config.defaultFolderPath = '/music';
    window.__responses['GET /library/files?directory=%2Fmusic'] = {
      directories: [{ path: '/music/slow' }],
      tracks: { items: [{ uri: 'library:track:1', title: 'Original', length_ms: 10000 }] },
    };
  });
  await load(page, 'library-browser.js');
  await page.locator('#foldersNavButton').click();
  await expect(page.locator('.folder-track-next')).toBeVisible();
}

test('folder navigation honors the latest path and disables stale folder playback while loading', async ({
  page,
}) => {
  await folderFixture(page);
  await page.evaluate(() => {
    window.__hold['GET /library/files?directory=%2Fmusic%2Fslow'] = true;
    window.__responses['GET /library/files'] = { directories: [{ path: '/root' }] };
  });
  await page.locator('[data-folder="/music/slow"]').click();
  await expect(page.locator('#folderPlayAll')).toBeDisabled();
  await expect(page.locator('#folderShuffle')).toBeDisabled();
  await page.locator('#folderCrumbs button').first().click();
  await expect(page.locator('[data-folder="/root"]')).toBeVisible();
  await page.evaluate(() =>
    window.__pending[0].resolve({ tracks: { items: [{ uri: 'old', title: 'Stale response' }] } })
  );
  await expect(page.locator('#folderBody')).not.toContainText('Stale response');
  await expect(page.locator('#folderPathLabel')).toHaveText('Local library');
  await expect(page.locator('#folderPlayAll')).toBeDisabled();
});

test('folder play-next inserts the new copy at the current position without moving existing duplicates', async ({
  page,
}) => {
  await folderFixture(page);
  await page.evaluate(() => {
    window.__responses['GET /player'] = { state: 'play' };
    window.__responses['GET /queue?id=now_playing'] = { items: [{ id: 900, position: 700 }] };
    window.__queue = Array.from({ length: 702 }, (_, id) => ({ id, uri: `library:track:${id + 1}` }));
    window.__onRequest = url => {
      if (url.startsWith('/queue/items/add?')) {
        // OwnTone jsonapi_reply_queue_tracks_add parses position and passes it
        // to queue_tracks_add_byuris; queue_item_to_json returns shuffle order
        // when shuffle is enabled. Contract reviewed in the official source:
        // https://github.com/owntone/owntone-server/blob/master/src/httpd_jsonapi.c
        const query = new URL(url, 'http://fixture').searchParams;
        const position = query.has('position') ? Number(query.get('position')) : window.__queue.length;
        window.__queue.splice(position, 0, { id: 999, uri: query.get('uris') });
      }
    };
  });
  await page.locator('.folder-track-next').click();
  const added = await page.evaluate(() =>
    window.__calls.filter(call => call.url.startsWith('/queue/items/add'))
  );
  expect(added).toHaveLength(1);
  expect(await page.evaluate(() => [window.__queue[0], window.__queue[701], window.__queue[702]])).toEqual([
    { id: 0, uri: 'library:track:1' },
    { id: 999, uri: 'library:track:1' },
    { id: 701, uri: 'library:track:702' },
  ]);
  const query = new URL(added[0].url, 'http://fixture').searchParams;
  expect(Object.fromEntries(query)).toEqual({
    uris: 'library:track:1',
    clear: 'false',
    playback: 'stop',
    position: '701',
  });
  expect(await page.evaluate(() => window.__calls.filter(call => call.method === 'PUT'))).toEqual([]);
  await page.evaluate(() => {
    window.__fail['GET /player'] = 'Player unavailable';
  });
  await page.locator('.folder-track-next').click();
  await expect(page.locator('.folder-error')).toContainText('Player unavailable');
  expect(await calls(page, 'POST', '/mock-start')).toEqual([]);
});

test('stats normalize numeric HTML fields and pause hidden or overlapping polling', async ({ page }) => {
  await fixture(page);
  await page.clock.install();
  await page.evaluate(() => {
    const payload = '<img class="injected" src=x>';
    window.__hold['GET /stats?days=30'] = true;
    window.__responses['GET /activity'] = { items: [] };
    window.__stats = {
      total_plays: payload,
      radio_plays: payload,
      days: [{ date: '2026-09-08', count: payload }],
      top_artists: [{ name: 'Artist', count: payload }],
    };
  });
  await load(page, 'stats.js');
  await page.clock.runFor(240000);
  expect(await calls(page, 'GET', '/stats?days=30')).toHaveLength(1);
  await page.evaluate(() => window.__pending[0].resolve(window.__stats));
  await expect(page.locator('#insightsSection .library-count')).toHaveText('0 plays · 0 radio');
  await expect(page.locator('#insightsSection .injected')).toHaveCount(0);
  await page.evaluate(() => {
    window.__hidden = true;
  });
  await page.clock.runFor(240000);
  expect(await calls(page, 'GET', '/stats?days=30')).toHaveLength(1);
  await page.evaluate(() => {
    window.__hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await calls(page, 'GET', '/stats?days=30')).toHaveLength(2);
});

test('notification polls do not overlap or move the last-seen timestamp backward', async ({ page }) => {
  await fixture(page);
  await page.clock.install();
  await page.evaluate(() => {
    window.Notification = class {
      static permission = 'granted';
      constructor(_title, options) {
        window.__toasts.push(options.body);
      }
    };
    document.hasFocus = () => false;
    localStorage.setItem('owntone-notify-enabled-v1', '1');
    localStorage.setItem('owntone-notify-last-seen', '2026-09-08T10:00:00Z');
    window.__hold['GET /activity'] = true;
  });
  await load(page, 'notifications.js');
  await page.clock.runFor(90000);
  expect(await calls(page, 'GET', '/activity')).toHaveLength(1);
  await page.evaluate(() =>
    window.__pending[0].resolve({
      items: [
        { at: '2026-09-08T09:00:00Z', kind: 'schedule', text: 'Old' },
        { at: '2026-09-08T12:01:00+02:00', kind: 'schedule', text: 'New' },
      ],
    })
  );
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('owntone-notify-last-seen')))
    .toBe('2026-09-08T10:01:00.000Z');
  expect(await page.evaluate(() => window.__toasts)).toEqual(['New']);
  await page.evaluate(() => {
    window.__hold['GET /activity'] = false;
    window.__responses['GET /activity'] = { items: [] };
  });
  await page.clock.runFor(45000);
  expect(await page.evaluate(() => localStorage.getItem('owntone-notify-last-seen'))).toBe(
    '2026-09-08T10:01:00.000Z'
  );
});

test('notification permission rejections are handled and polling stays off', async ({ page }) => {
  await fixture(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => {
    window.Notification = class {
      static permission = 'default';
      static async requestPermission() {
        throw new Error('Permission API failed');
      }
    };
  });
  await load(page, 'notifications.js');
  await page.locator('#notifyButton').click();
  await expect
    .poll(() => page.evaluate(() => window.__toasts))
    .toContain('Notification permission unavailable');
  await expect(page.locator('#notifyButton')).toHaveAttribute('aria-pressed', 'false');
  expect(await calls(page, 'GET', '/activity')).toEqual([]);
  expect(errors).toEqual([]);
});

test('multi-room ignores malformed saved scenes and guards concurrent selection changes', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    localStorage.setItem(
      'owntone-output-scenes-v1',
      JSON.stringify([null, { id: 'bad', name: 'Bad', outputs: [null] }])
    );
    window.OWNTONE_APP.state.outputs.push(
      { id: 'office', name: 'Office', selected: false },
      { id: 'kitchen', name: 'Kitchen', selected: false }
    );
    window.__hold['PUT /outputs/set'] = true;
  });
  await load(page, 'context-multiroom.js');
  await page.locator('#premiumOutputButton').click();
  await expect(page.locator('[data-scene-apply]')).toHaveCount(0);
  await page.locator('[data-mr-output="office"] .multiroom-toggle').click();
  await expect(page.locator('[data-mr-output="kitchen"] .multiroom-toggle')).toBeDisabled();
  expect(await calls(page, 'PUT', '/outputs/set')).toHaveLength(1);
  await page.evaluate(() => window.__pending[0].reject(new Error('Speaker unavailable')));
  await expect(page.locator('[data-mr-output="kitchen"] .multiroom-toggle')).toBeEnabled();
  expect(await page.evaluate(() => window.__toasts)).toContain('Output change failed: Speaker unavailable');
});

test('late exact album tracks cannot replace a newer album and track numbers are escaped', async ({
  page,
}) => {
  await fixture(page);
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div class="album-card" data-uri="library:album:a"><div class="album-copy"><b>A</b></div><button class="album-info-button">A</button></div>
      <div class="album-card" data-uri="library:album:b"><div class="album-copy"><b>B</b></div><button class="album-info-button">B</button></div><div id="albumTrackList"></div><span id="albumTrackCount"></span>`
    );
    window.__hold['GET /library/albums/a/tracks?limit=100'] = true;
    window.__responses['GET /library/albums/b/tracks?limit=100'] = {
      items: [{ uri: 'library:track:b', title: 'Track B', track_number: '<img class="injected" src=x>' }],
    };
  });
  await load(page, 'context-multiroom.js');
  await page.locator('.album-info-button').first().click();
  await expect.poll(() => calls(page, 'GET', '/library/albums/a/tracks?limit=100')).toHaveLength(1);
  await page.locator('.album-info-button').last().click();
  await page.evaluate(() =>
    window.__pending[0].resolve({ items: [{ uri: 'library:track:a', title: 'Track A' }] })
  );
  await expect(page.locator('#albumTrackList')).toContainText('Track B');
  await expect(page.locator('#albumTrackList')).not.toContainText('Track A');
  await expect(page.locator('#albumTrackList .injected')).toHaveCount(0);
});
