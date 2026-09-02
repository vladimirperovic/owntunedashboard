const { test, expect } = require('@playwright/test');

test(
  'one-click updater detects new main, turns green, installs it and reports the commit',
  async ({ page }) => {
    let requested = false;
    let statusAfterRequest = 0;
    let checks = 0;

    await page.route('**/updater/check', async route => {
      checks += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          current: { commit: '1111111111111111111111111111111111111111' },
          latest: {
            commit: 'abcdef0123456789abcdef0123456789abcdef01',
            checked_at: '2026-09-02T12:00:00+02:00',
          },
          update_available: true,
          check_interval_seconds: 43200,
        }),
      });
    });

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
    await expect(button).toHaveClass(/update-available/);
    await expect(button.locator('span')).toHaveText('Update available');
    await expect(status).toHaveText('New abcdef0 · current 1111111');
    expect(checks).toBe(1);

    await button.click();
    await expect(status).toHaveText('Update queued…', { timeout: 3000 });
    await expect(status).toHaveText('Installed abcdef0', { timeout: 5000 });
    expect(requested).toBe(true);
  }
);
