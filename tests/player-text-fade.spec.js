const { test, expect } = require('@playwright/test');
const { exposeMutableState } = require('./helpers/app-state');

test('song and station changes fade once, with the latest text available immediately', async ({ page }) => {
  await exposeMutableState(page);
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode');
  const result = await page.evaluate(async () => {
    const app = window.OWNTONE_APP;
    const title = document.getElementById('trackTitle');
    const artist = document.getElementById('trackArtist');
    const fades = el => el.getAnimations().filter(a => a.id === 'owntone-text-fade');
    await app.playerCommand('next');
    const firstFade = fades(title)[0];
    const song = { title: title.textContent, fading: !!firstFade, artistFading: fades(artist).length === 1 };
    await app.playerCommand('toggle');
    const sameFade = fades(title)[0] === firstFade;
    await app.playerCommand('previous');
    const latestSong = title.textContent;
    const oldCancelled = firstFade.playState === 'idle';
    window.__testState.current = { title: 'Station One', artist: 'Artist — Song One', data_kind: 'url' };
    await app.playerCommand('toggle');
    window.__testState.current = { title: 'Station Two', artist: 'Artist — Song Two', data_kind: 'url' };
    await app.playerCommand('toggle');
    return {
      song,
      sameFade,
      latestSong,
      oldCancelled,
      station: title.textContent,
      radioText: artist.textContent,
      stationFades: fades(title).length,
      radioFades: fades(artist).length,
    };
  });
  expect(result).toEqual({
    song: { title: 'Riders on the Storm', fading: true, artistFading: true },
    sameFade: true,
    latestSong: 'Teardrop',
    oldCancelled: true,
    station: 'Station Two',
    radioText: 'Artist — Song Two',
    stationFades: 1,
    radioFades: 1,
  });
});

test('reduced motion updates player text without a fade', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode');
  const result = await page.evaluate(async () => {
    await window.OWNTONE_APP.playerCommand('next');
    const title = document.getElementById('trackTitle');
    return {
      text: title.textContent,
      fades: title.getAnimations().filter(a => a.id === 'owntone-text-fade').length,
    };
  });
  expect(result).toEqual({ text: 'Riders on the Storm', fades: 0 });
});
