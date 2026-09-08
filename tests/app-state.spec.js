const { test, expect } = require('@playwright/test');
const { exposeMutableState } = require('./helpers/app-state');

async function openDemo(page) {
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode');
  await expect(page.locator('#fullscreenVolumeRange')).toBeAttached();
}

test('public state rejects direct, nested, array and descriptor mutations', async ({ page }) => {
  await openDemo(page);
  const result = await page.evaluate(() => {
    const state = window.OWNTONE_APP.state;
    const before = JSON.stringify(state);
    const attempts = [
      () => {
        state.demo = false;
      },
      () => {
        state.player.volume = 99;
      },
      () => {
        state.outputs.push({ id: 'injected' });
      },
      () => {
        Object.getOwnPropertyDescriptor(state, 'player').value.volume = 99;
      },
      () => {
        delete state.current;
      },
      () => {
        Object.setPrototypeOf(state.player, {});
      },
    ];
    return {
      rejected: attempts.map(attempt => {
        try {
          attempt();
          return false;
        } catch (_) {
          return true;
        }
      }),
      unchanged: before === JSON.stringify(state),
      hasPrivateTimers: 'searchTimer' in state || 'volumeDragging' in state,
    };
  });
  expect(result.rejected).toEqual(Array(6).fill(true));
  expect(result.unchanged).toBe(true);
  expect(result.hasPrivateTimers).toBe(false);
});

test('actions publish detached immutable playback snapshots', async ({ page }) => {
  await openDemo(page);
  const result = await page.evaluate(async () => {
    const app = window.OWNTONE_APP;
    const before = app.getSnapshot();
    let detail;
    const off = window.OwnTone.on('owntone:player-updated', event => {
      detail = event.detail;
    });
    await app.playerCommand('next');
    off();
    const eventTitle = detail.current.title;
    await app.playerCommand('previous');
    return {
      before: before.current.title,
      eventTitle,
      retainedTitle: detail.current.title,
      currentTitle: app.state.current.title,
      frozen: Object.isFrozen(detail) && Object.isFrozen(detail.player) && Object.isFrozen(detail.outputs),
    };
  });
  expect(result.before).toBe('La Vie En Rose');
  expect(result.eventTitle).toBe('Riders on the Storm');
  expect(result.retainedTitle).toBe(result.eventTitle);
  expect(result.currentTitle).toBe('Teardrop');
  expect(result.frozen).toBe(true);
});

test('rejected per-room volume writes leave shared state unchanged', async ({ page }) => {
  await exposeMutableState(page);
  await openDemo(page);
  await page.route('**/api/outputs/hp', route => route.fulfill({ status: 503, json: { error: 'offline' } }));
  const result = await page.evaluate(async () => {
    const app = window.OWNTONE_APP;
    window.__testState.demo = false;
    const before = app.state.outputs[0].volume;
    let rejected = false;
    try {
      await app.setPhysicalOutputVolume('hp', 61);
    } catch (_) {
      rejected = true;
    }
    return { before, after: app.state.outputs[0].volume, rejected };
  });
  expect(result.rejected).toBe(true);
  expect(result.after).toBe(result.before);
});
