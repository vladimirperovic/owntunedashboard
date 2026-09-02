const { test, expect } = require('@playwright/test');

test('one-click updater queues latest main and reports the installed commit', async ({ page }) => {
  let requested = false;
  let statusAfterRequest = 0;

  await page.route('**/updater/status', async route => {
    if (!requested) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          current: { commit: '1111111111111111111111111111111111111111' },
          pending: false,
          running: false,
          result: null,
        }),
      });
      return;
    }

    statusAfterRequest += 1;
    const body =
      statusAfterRequest === 1
        ? {
            ok: true,
            current: { commit: '1111111111111111111111111111111111111111' },
            pending: true,
            running: false,
            result: null,
          }
        : {
            ok: true,
            current: { commit: 'abcdef0123456789abcdef0123456789abcdef01' },
            pending: false,
            running: false,
            result: {
              status: 'success',
              commit: 'abcdef0123456789abcdef0123456789abcdef01',
              at: '2026-09-02T12:05:00+02:00',
            },
          };

    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.route('**/updater/request', async route => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().headers()['x-owntone-update']).toBe('1');
    requested = true;
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, queued: true }),
    });
  });

  page.on('dialog', dialog => dialog.accept());
  await page.goto('/', { waitUntil: 'load' });
  await expect(page.locator('#connectionText')).toContainText('Preview mode', { timeout: 12000 });

  const button = page.locator('#dashboardUpdateButton');
  const status = page.locator('#dashboardUpdateStatus');
  await expect(button).toBeVisible();
  await expect(status).toHaveText('Current 1111111');

  await button.click();
  await expect(status).toHaveText('Update queued…', { timeout: 3000 });
  await expect(status).toHaveText('Installed abcdef0', { timeout: 5000 });
  expect(requested).toBe(true);
});
