const { test, expect } = require('@playwright/test');

test('updater turns green for new main and installs it', async ({ page }) => {
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
  await expect(button.locator('.dashboard-update-label')).toHaveText('Update available');
  await expect(status).toBeHidden();
  expect(checks).toBe(1);

  await button.click();
  await expect(status).toHaveText('Update queued…', { timeout: 3000 });
  await expect(status).toHaveText('Update installed — reloading…', { timeout: 5000 });
  expect(requested).toBe(true);
});

test('updater reports incomplete rollback without claiming the old release was restored', async ({
  page,
}) => {
  let requested = false;
  const message = 'Update failed; rollback incomplete, manual recovery required';
  await page.route('**/updater/check', route => route.fulfill({ json: { update_available: true } }));
  await page.route('**/updater/status', route =>
    route.fulfill({
      json: {
        pending: false,
        running: false,
        result: requested ? { status: 'error', at: '2026-09-08T10:00:00Z', message } : null,
      },
    })
  );
  await page.route('**/updater/request', route => {
    requested = true;
    return route.fulfill({ status: 202, json: { queued: true } });
  });
  page.on('dialog', dialog => dialog.accept());
  await page.goto('/');
  await expect(page.locator('#dashboardUpdateButton')).toBeVisible();
  await page.locator('#dashboardUpdateButton').click();
  await expect(page.locator('#dashboardUpdateStatus')).toHaveText(message);
  await expect(page.locator('#toast')).toHaveText(message);
  await expect(page.locator('#dashboardUpdateButton')).toBeEnabled();
});

test('last update shows date and release; checking discovers updates without installing', async ({
  page,
}) => {
  const current = { commit: '1'.repeat(40), deployed_at: '2026-09-08T12:00:00Z' };
  let installs = 0;
  let forced = false;
  await page.route('**/updater/status', route => route.fulfill({ json: { current } }));
  await page.route('**/updater/check*', route => {
    forced = new URL(route.request().url()).searchParams.get('force') === '1';
    return route.fulfill({ json: { current, update_available: forced, latest: { commit: '2'.repeat(40) } } });
  });
  await page.route('**/updater/request', route => {
    installs += 1;
    return route.fulfill({ status: 202, json: { queued: true } });
  });
  await page.goto('/');
  const button = page.locator('#dashboardUpdateButton');
  await expect(button.locator('.dashboard-update-label')).toHaveText('Last update');
  await expect(button.locator('small')).toHaveText('08.09.2026 · v32');
  await expect(page.locator('#dashboardUpdateStatus')).toBeHidden();
  await button.click();
  await expect(button.locator('.dashboard-update-label')).toHaveText('Update available');
  await expect(button).toHaveClass(/update-available/);
  expect(forced).toBe(true);
  expect(installs).toBe(0);
  await expect(page.locator('#serverVersion')).toHaveCount(0);
});

test('sidebar fits all navigation and its footer scrolls with the page', async ({ page }) => {
  const current = { deployed_at: '2026-09-08T12:00:00Z' };
  await page.route('**/updater/status', route => route.fulfill({ json: { current } }));
  await page.route('**/updater/check', route =>
    route.fulfill({ json: { current, update_available: false } })
  );
  await page.goto('/');
  await expect(page.locator('#dashboardUpdateButton')).toBeVisible();
  await expect(page.locator('#browseNavButton')).toBeAttached();
  for (const viewport of [
    { width: 1280, height: 600 },
    { width: 1024, height: 480 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    const layout = await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar').getBoundingClientRect();
      const nav = document.querySelector('.side-nav');
      const footer = document.querySelector('.sidebar-foot').getBoundingClientRect();
      nav.scrollTop = nav.scrollHeight;
      const last = nav.querySelector('[data-nav="mymusic"]').getBoundingClientRect();
      return {
        sidebarBottom: sidebar.bottom,
        footerBottom: footer.bottom,
        footerTop: footer.top,
        navBottom: nav.getBoundingClientRect().bottom,
        lastBottom: last.bottom,
        scroll: nav.scrollTop,
        position: getComputedStyle(document.querySelector('.sidebar')).position,
        innerScroll: nav.scrollHeight > nav.clientHeight,
      };
    });
    expect(layout.footerBottom).toBeLessThanOrEqual(layout.sidebarBottom);
    expect(layout.position).toBe('relative');
    expect(layout.innerScroll).toBe(false);
    expect(layout.navBottom).toBeLessThanOrEqual(layout.footerTop + 1);
    expect(layout.lastBottom).toBeLessThanOrEqual(layout.navBottom + 1);
    expect(layout.scroll).toBe(0);
    await page.evaluate(() => window.scrollBy({ top: 160, behavior: 'instant' }));
    await expect
      .poll(async () => (await page.locator('.sidebar-foot').boundingBox()).y)
      .toBeLessThan(layout.footerTop - 100);
  }
});

test('mobile More shows the same installed date and update availability', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const current = { deployed_at: '2026-09-08T12:00:00Z' };
  await page.route('**/updater/status', route => route.fulfill({ json: { current } }));
  await page.route('**/updater/check', route => route.fulfill({ json: { current, update_available: true } }));
  await page.goto('/');
  await expect(page.locator('#dashboardUpdateButton')).toHaveAttribute('data-update-available', 'true');
  await page.locator('#dockMoreButton').click();
  await expect(page.locator('[data-safe-more="update"]')).toContainText(
    'Update available · 08.09.2026 · v32'
  );
});

test('playback controls form a padded group at the left of the player', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#connectionText')).toContainText('Preview mode');
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const row = document.querySelector('.transport-row');
      const rect = row.getBoundingClientRect();
      const title = document.getElementById('trackTitle').getBoundingClientRect();
      const buttons = [...row.querySelectorAll('button')].map(b => b.getBoundingClientRect());
      return {
        width: rect.width,
        left: rect.left,
        titleLeft: title.left,
        padding: parseFloat(getComputedStyle(row).paddingTop),
        right: rect.right,
        buttonRight: buttons.at(-1).right,
        gaps: buttons.slice(1).map((b, i) => b.left - buttons[i].right),
      };
    });
    expect(layout.width).toBeLessThan(330);
    expect(Math.abs(layout.left - layout.titleLeft)).toBeLessThan(8);
    expect(layout.padding).toBeGreaterThanOrEqual(8);
    expect(layout.buttonRight).toBeLessThanOrEqual(layout.right + 1);
    expect(layout.gaps.every(gap => gap >= 5)).toBe(true);
  }
});
