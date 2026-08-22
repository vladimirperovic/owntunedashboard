const { test, expect } = require('@playwright/test');

test('now playing changes automatically with fresh data and a fade', async ({ page }) => {
  let current = 1;
  const tracks = {
    1: {id:'q1',track_id:101,title:"I'm Gonna Love You Just a Little More Baby",artist:'Barry White',album:'The Ultimate Collection',type:'mp3',bitrate:128,samplerate:44100,channels:2,length_ms:180000,artwork_url:'/artwork/item/101'},
    2: {id:'q2',track_id:102,title:'Just the Two of Us',artist:'Bill Withers',album:'Bill Withers Collection',type:'flac',bitrate:1411,samplerate:96000,bits_per_sample:24,channels:2,length_ms:240000,artwork_url:'/artwork/item/102'},
  };

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === '/api/player') {
      return route.fulfill({json:{state:'play',volume:31,item_progress_ms:12000,item_length_ms:tracks[current].length_ms,item_id:`q${current}`}});
    }
    if (path === '/api/queue' && url.searchParams.get('id') === 'now_playing') return route.fulfill({json:{count:1,items:[tracks[current]]}});
    if (path === '/api/queue' && url.searchParams.has('start')) return route.fulfill({json:{count:1,items:[tracks[current]]}});
    if (path === '/api/outputs') return route.fulfill({json:{outputs:[{id:'hp',name:'Living Room',type:'AirPlay',selected:true,volume:31,format:'alac'}]}});
    if (path === '/api/library/playlists') return route.fulfill({json:{items:[]}});
    if (path === '/api/library/albums') return route.fulfill({json:{items:[]}});
    if (path === '/api/library') return route.fulfill({json:{songs:2,albums:2,artists:2}});
    if (path === '/api/config') return route.fulfill({json:{version:'test'}});
    if (path === '/api/search') return route.fulfill({json:{tracks:{items:[]},albums:{items:[]},artists:{items:[]},playlists:{items:[]}}});
    return route.fulfill({status:204,body:''});
  });
  await page.route('**/artwork/item/**', route => {
    if (new URL(route.request().url()).pathname.endsWith('/102')) return route.fulfill({status:204,body:''});
    return route.fulfill({
      contentType:'image/svg+xml',
      body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#f15b45"/></svg>',
    });
  });
  await page.route('**/scheduler/**', route => route.fulfill({json:{items:[]}}));
  await page.addInitScript(() => {
    class MockOwnToneWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor() {
        this.readyState = MockOwnToneWebSocket.CONNECTING;
        window.__owntoneSocket = this;
        setTimeout(() => { this.readyState = MockOwnToneWebSocket.OPEN; this.onopen?.(); }, 0);
      }
      send() {}
      close() { this.readyState = MockOwnToneWebSocket.CLOSED; this.onclose?.(); }
    }
    window.WebSocket = MockOwnToneWebSocket;
    window.__emitOwnToneEvent = payload => window.__owntoneSocket?.onmessage?.({data:JSON.stringify(payload)});
  });

  await page.setViewportSize({width:1440,height:1000});
  await page.goto('/');
  await expect(page.locator('#trackTitle')).toContainText("I'm Gonna Love You");
  const artwork = await page.locator('#playerArt').boundingBox();
  // artwork sits right of the title as a compact 212px square on desktop
  expect(artwork.width).toBeGreaterThanOrEqual(180);
  expect(artwork.width).toBeLessThanOrEqual(260);

  current = 2;
  await page.evaluate(() => window.__emitOwnToneEvent({notify:['player']}));
  await expect(page.locator('.player-card.track-refreshed')).toBeVisible({timeout:5000});
  await expect(page.locator('#trackTitle')).toHaveText('Just the Two of Us');
  await expect(page.locator('#trackArtist')).toHaveText('Bill Withers');
  await expect(page.locator('#trackChips')).toContainText('96 kHz');
  await expect(page.locator('#trackChips')).toContainText('24-bit');
  await expect(page.locator('#trackChips')).toContainText('≈ 42.3 MB');
  await expect(page.locator('#playerArt')).toHaveClass(/has-art/);
  await expect.poll(() => page.locator('#artwork').getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
});

test('live radio keeps the current station when previous or next is requested', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode', { timeout: 12000 });
  const result = await page.evaluate(async () => {
    window.OWNTONE_APP.state.current = {title:'Radio Kotor Live', artist:'Radio Kotor Live', data_kind:'url', path:'https://example.test/stream'};
    const before = window.OWNTONE_APP.state.current.title;
    await window.OWNTONE_APP.playerCommand('next');
    return {before, after:window.OWNTONE_APP.state.current.title, toast:document.getElementById('toast').textContent};
  });
  expect(result.after).toBe(result.before);
  expect(result.toast).toContain('no previous or next track');
});
