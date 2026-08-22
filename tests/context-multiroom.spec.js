const { test, expect } = require('@playwright/test');

function ownToneRoutes(page) {
  const outputs = [
    {id:'hp',name:'Living room',type:'AirPlay',selected:true,volume:18,format:'alac'},
    {id:'office',name:'Office HomePod',type:'AirPlay',selected:false,volume:22,format:'alac'},
    {id:'kitchen',name:'Kitchen',type:'AirPlay',selected:false,volume:16,format:'alac'},
    {id:'mac',name:"Test MacBook",type:'AirPlay',selected:false,volume:22,format:'alac',requires_auth:true,needs_auth_key:true},
  ];
  const requests = { queueAdds: [], outputSets: [], outputVolumes: [], outputPins: [] };

  page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/api/player') return route.fulfill({json:{state:'play',volume:18,item_progress_ms:21000,item_length_ms:240000,item_id:'q1'}});
    if (path === '/api/queue' && url.searchParams.get('id') === 'now_playing') return route.fulfill({json:{count:7,items:[{id:'q1',position:2,title:'Teardrop',artist:'Massive Attack',album:'Mezzanine',album_id:'123',uri:'library:track:42',data_kind:'file',type:'flac',bitrate:'Lossless',length_ms:240000}]}});
    if (path === '/api/queue' && url.searchParams.has('start')) return route.fulfill({json:{count:7,items:[]}});
    if (path === '/api/outputs' && method === 'GET') return route.fulfill({json:{outputs}});
    if (path === '/api/outputs/set' && method === 'PUT') {
      const body = JSON.parse(request.postData() || '{}');
      requests.outputSets.push(body);
      const ids = (body.outputs || []).map(String);
      outputs.forEach(output => { output.selected = ids.includes(String(output.id)); });
      return route.fulfill({status:204,body:''});
    }
    const outputMatch = path.match(/^\/api\/outputs\/([^/]+)$/);
    if (outputMatch && method === 'PUT') {
      const body = JSON.parse(request.postData() || '{}');
      requests.outputVolumes.push({id:decodeURIComponent(outputMatch[1]),...body});
      const output = outputs.find(item => String(item.id) === decodeURIComponent(outputMatch[1]));
      if (output && body.volume != null) output.volume = Number(body.volume);
      if (output && body.pin) {
        requests.outputPins.push({id:output.id,pin:String(body.pin)});
        output.requires_auth = false;
        output.needs_auth_key = false;
        output.selected = body.selected === true;
      } else if (output && body.selected === true && !output.requires_auth && !output.needs_auth_key) {
        output.selected = true;
      }
      return route.fulfill({status:204,body:''});
    }
    if (path === '/api/library/playlists') return route.fulfill({json:{items:[{id:'p1',name:'Favorites',path:'/media/music/Playlists/Favorites.smartpl',uri:'library:playlist:1'}]}});
    if (path === '/api/library/albums') return route.fulfill({json:{items:[{id:'123',name:'Mezzanine',artist:'Massive Attack',uri:'library:album:123'}]}});
    if (path === '/api/library/albums/123/tracks') return route.fulfill({json:{items:[
      {id:42,uri:'library:track:42',title:'Teardrop',artist:'Massive Attack',album:'Mezzanine',track_number:3,length_ms:331000},
      {id:43,uri:'library:track:43',title:'Angel',artist:'Massive Attack',album:'Mezzanine',track_number:1,length_ms:379000},
    ]}});
    if (path === '/api/library') return route.fulfill({json:{songs:2,albums:1,artists:1}});
    if (path === '/api/config') return route.fulfill({json:{version:'test'}});
    if (path === '/api/queue/items/add' && method === 'POST') {
      requests.queueAdds.push(Object.fromEntries(url.searchParams.entries()));
      return route.fulfill({json:{version:1,count:1,items:[]}});
    }
    if (path.startsWith('/api/player/volume') && method === 'PUT') return route.fulfill({status:204,body:''});
    if (path.startsWith('/api/player/') && method === 'PUT') return route.fulfill({status:204,body:''});
    if (path === '/api/search') return route.fulfill({json:{tracks:{items:[]},albums:{items:[]},artists:{items:[]},playlists:{items:[]}}});
    return route.fulfill({status:404,json:{error:'mock missing'}});
  });

  page.route('**/scheduler/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/history')) return route.fulfill({json:{items:[{title:'Teardrop',artist:'Massive Attack',album:'Mezzanine',play_uri:'library:track:42'}]}});
    if (url.pathname.endsWith('/health')) return route.fulfill({json:{ok:true}});
    return route.fulfill({json:{items:[]}});
  });
  return requests;
}

async function openOnline(page, viewport) {
  await page.setViewportSize(viewport);
  const requests = ownToneRoutes(page);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('OwnTone connected', {timeout:12000});
  await expect(page.locator('#premiumOutputButton')).toBeVisible();
  await expect(page.locator('.album-card').first()).toBeVisible();
  return {requests,errors};
}
async function noOverflow(page) {
  const size = await page.evaluate(() => ({inner:innerWidth,scroll:document.documentElement.scrollWidth}));
  expect(size.scroll).toBeLessThanOrEqual(size.inner + 1);
}

test('desktop context actions and multi-room use native OwnTone contracts', async ({page}) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = function () {
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    };
    HTMLMediaElement.prototype.load = function () {};
  });
  const {requests,errors} = await openOnline(page,{width:1440,height:1000});
  await noOverflow(page);
  await page.locator('#premiumOutputButton').click();
  await expect(page.locator('#multiroomSheet')).toHaveClass(/open/);
  await expect(page.locator('.multiroom-output-row')).toHaveCount(5);
  await page.locator('[data-mr-output="office"] .multiroom-toggle').click();
  await expect.poll(() => requests.outputSets.length).toBeGreaterThan(0);
  expect(requests.outputSets.at(-1).outputs.sort()).toEqual(['hp','office']);
  await expect(page.locator('#premiumOutputButton b')).toHaveText('2 outputs');
  const officeVolume = page.locator('[data-mr-output="office"] .multiroom-volume');
  await officeVolume.fill('31');
  await officeVolume.dispatchEvent('change');
  await expect.poll(() => requests.outputVolumes.some(item => item.id === 'office' && item.volume === 31)).toBeTruthy();
  await page.locator('#multiroomSceneName').fill('Living + Office');
  await page.locator('#multiroomSaveScene').click();
  await expect(page.locator('[data-scene-apply]')).toContainText('Living + Office');
  await page.locator('[data-scene-apply]').click();
  await expect.poll(() => requests.outputSets.at(-1).outputs.slice().sort().join(',')).toBe('hp,office');
  await page.locator('[data-mr-output="mac"] .multiroom-toggle').click();
  await expect(page.locator('[data-mr-output="mac"] .multiroom-auth')).toBeVisible();
  await page.locator('[data-mr-output="mac"] .multiroom-pin').fill('1234');
  await page.locator('[data-mr-output="mac"] .multiroom-auth button').click();
  await expect.poll(() => requests.outputPins.at(-1)).toEqual({id:'mac',pin:'1234'});
  await expect(page.locator('[data-mr-output="mac"]')).toHaveClass(/active/);
  await page.locator('[data-mr-output="browser"] .multiroom-toggle').click();
  // browser is an independent output — AirPlay selection must stay untouched
  const setsBeforeBrowser = requests.outputSets.length;
  await expect(page.locator('[data-mr-output="browser"]')).toHaveClass(/active/);
  await expect(page.locator('[data-mr-output="browser"] small')).toContainText('Playing');
  expect(requests.outputSets.length).toBe(setsBeforeBrowser);
  await page.locator('[data-mr-output="browser"] .multiroom-toggle').click();
  await expect(page.locator('[data-mr-output="browser"]')).not.toHaveClass(/active/);
  expect(requests.outputSets.length).toBe(setsBeforeBrowser);
  await page.locator('.multiroom-close').click();

  const album = page.locator('.album-card').first();
  await album.locator(':scope > .context-menu-trigger').evaluate(element => element.click());
  await expect(page.locator('#contextActionMenu')).toBeVisible();
  await page.locator('[data-context-action="play-next"]').click();
  await expect.poll(() => requests.queueAdds.length).toBeGreaterThan(0);
  expect(requests.queueAdds.at(-1).position).toBe('3');
  expect(requests.queueAdds.at(-1).uris).toBe('library:album:123');

  await album.locator('.album-info-button').click();
  await expect(page.locator('#albumDetailDialog')).toBeVisible();
  await expect(page.locator('.album-track-row[data-context-uri]')).toHaveCount(2);
  await page.locator('.album-track-row[data-context-uri]').first().locator('.context-menu-trigger').evaluate(element => element.click());
  await page.locator('[data-context-action="play-last"]').click();
  await expect.poll(() => requests.queueAdds.length).toBeGreaterThan(1);
  expect(requests.queueAdds.at(-1).position).toBe('7');
  expect(requests.queueAdds.at(-1).uris).toBe('library:track:42');
  expect(errors).toEqual([]);
  await noOverflow(page);
  await page.screenshot({path:'test-results/desktop-context-multiroom.png',fullPage:true});
});

test('mobile context menu and multi-room remain within viewport', async ({page}) => {
  const {errors} = await openOnline(page,{width:390,height:844});
  await noOverflow(page);
  await page.locator('#premiumOutputButton').click();
  const panel = page.locator('.multiroom-panel');
  await expect(panel).toBeVisible();
  const panelBox = await panel.boundingBox();
  expect(panelBox.width).toBeLessThanOrEqual(390);
  expect(panelBox.height).toBeLessThanOrEqual(844);
  await page.locator('[data-mr-output="office"] .multiroom-toggle').click();
  await expect(page.locator('#premiumOutputButton b')).toHaveText('2 outputs');
  await page.locator('.multiroom-close').click();
  const trigger = page.locator('.album-card').first().locator(':scope > .context-menu-trigger');
  await trigger.evaluate(el => el.dispatchEvent(new PointerEvent('pointerup', {bubbles:true,cancelable:true,pointerType:'touch'})));
  const menu = page.locator('#contextActionMenu');
  await expect(menu).toBeVisible();
  const menuBox = await menu.boundingBox();
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.y).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(390);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(844);
  await expect(page.locator('[data-context-action="play-next"]')).toBeVisible();
  await expect(page.locator('[data-context-action="add-queue"]')).toBeVisible();
  await expect(page.locator('[data-context-action="play-last"]')).toBeVisible();
  expect(errors).toEqual([]);
  await noOverflow(page);
  await page.screenshot({path:'test-results/mobile-context-multiroom.png',fullPage:true});
});
