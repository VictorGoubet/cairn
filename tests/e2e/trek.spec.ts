// the trek features: multi-day stages, weather, qr handoff, offline shell
import { expect, test } from '@playwright/test';
import { CEILLAC, clickAt, openPlanner, type TestHandles, waitForRouting } from './helpers';

// all three inside the z14 viewport: a click projected past its edge lands on nothing
const FURTHER: [number, number] = [CEILLAC[0] + 0.008, CEILLAC[1] + 0.001];
const BEYOND: [number, number] = [CEILLAC[0] + 0.013, CEILLAC[1] + 0.005];

async function drawTrek(page: import('@playwright/test').Page): Promise<void> {
  await openPlanner(page);
  await page.locator('.segmented button', { hasText: /Manuel|Manual/ }).click();
  await clickAt(page, CEILLAC);
  await clickAt(page, FURTHER);
  await clickAt(page, BEYOND);
  await waitForRouting(page, 2);
  // the middle point becomes a camp: that cut is what makes it a trek
  await page.locator('.maplibregl-marker .anchor-marker').first().click();
  await page.locator('.kind-option', { hasText: /Bivouac|Camp/ }).click();
  await page.locator('.point-name').fill('Bivouac du lac');
  await page.keyboard.press('Escape');
}

test.describe('multi-day stages', () => {
  test('a camp point cuts the trek into named days', async ({ page }) => {
    await drawTrek(page);
    const rows = page.locator('.stages-list li');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('J1');
    await expect(rows.first()).toContainText('Bivouac du lac');
    await expect(rows.first()).toContainText(/min|h/);
    // the block folds away when the panel gets crowded, and remembers nothing: a session choice
    await page.locator('.stages-toggle').click();
    await expect(page.locator('.stages-list')).toHaveCount(0);
    await page.locator('.stages-toggle').click();
    await expect(rows).toHaveCount(2);

    // every point of the list says what is still ahead of it
    const remainingTexts = await page.locator('.wp-remaining').allTextContents();
    expect(remainingTexts.length).toBeGreaterThanOrEqual(2);
    expect(remainingTexts[0]).toMatch(/\+\d+ m · -\d+ m/);

    // removing the camp merges the days back
    await page.locator('.wp-marker .poi-icon').first().click();
    await page.locator('.point-editor button', { hasText: /Supprimer|Delete/ }).click();
    await expect(page.locator('[data-control="stages"]')).toHaveCount(0);
  });

  test('the gpx export writes one track per day', async ({ page }) => {
    await drawTrek(page);
    await page.locator('.topbar button', { hasText: /Exporter|Export/ }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('.export-menu button', { hasText: 'GPX' }).click();
    const body = await (await downloadPromise)
      .createReadStream()
      .then(stream => new Promise<string>(resolve => {
        let out = '';
        stream.on('data', (chunk: Buffer) => {
          out += chunk.toString();
        });
        stream.on('end', () => resolve(out));
      }));
    expect(body).toContain('<name>Jour 1 · Bivouac du lac</name>');
    expect(body).toContain('<name>Jour 2</name>');
  });

  test('a start date brings each day its forecast', async ({ page }) => {
    await page.route('**/api.open-meteo.com/**', route =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          daily: {
            time: ['x'],
            weather_code: [61],
            temperature_2m_max: [14.2],
            temperature_2m_min: [6.8],
            precipitation_sum: [7],
            wind_speed_10m_max: [40],
          },
        }),
      }),
    );
    await drawTrek(page);
    const today = new Date().toISOString().slice(0, 10);
    await page.locator('.stages-date input').fill(today);
    const first = page.locator('.stages-list li').first();
    await expect(first.locator('.stage-weather')).toContainText('🌧️');
    await expect(first.locator('.stage-weather')).toContainText('7° / 14°');
    await expect(first.locator('.stage-weather')).toContainText('7 mm');
    // the date survives a reload with the draft
    await page.reload();
    await page.waitForFunction(() => '__planner' in window);
    await expect(page.locator('.stages-date input')).toHaveValue(today);
  });
});

test.describe('offline download', () => {
  test('the routes gallery downloads a corridor into the cache storage', async ({ page }) => {
    // the corridor is fetched for real otherwise: tiny stand-ins keep the test hermetic
    await page.route('**data.geopf.fr/**', route => route.fulfill({ body: 'tile' }));
    await page.route('**tile.openstreetmap.org/**', route => route.fulfill({ body: 'tile' }));
    await page.route('**refuges.info/**', route =>
      route.fulfill({ contentType: 'application/json', body: '{"features":[]}' }),
    );
    await page.route('**overpass-api.de/**', route =>
      route.fulfill({ contentType: 'application/json', body: '{"elements":[]}' }),
    );
    await openPlanner(page);
    await page.locator('.segmented button', { hasText: /Manuel|Manual/ }).click();
    await clickAt(page, CEILLAC);
    await clickAt(page, FURTHER);
    await waitForRouting(page, 1);
    await page.evaluate(() => (window as unknown as TestHandles).__planner.getState().saveCurrentRoute('hors ligne'));

    await page.locator('.topbar button', { hasText: /itinéraires|routes/i }).click();
    await page.locator('[data-control="route-offline"]').click();
    await expect(page.locator('[data-control="route-offline"].saved')).toBeVisible({ timeout: 30_000 });

    const cached = await page.evaluate(async () => {
      const cache = await caches.open('cairn-offline-v1');
      const keys = await cache.keys();
      return {
        total: keys.length,
        plan: keys.filter(k => k.url.includes('PLAN.IGN/14/')).length,
        scan25: keys.filter(k => k.url.includes('SCAN25TOUR')).length,
        ortho: keys.filter(k => k.url.includes('ORTHOIMAGERY')).length,
        osm: keys.filter(k => k.url.includes('tile.openstreetmap.org')).length,
        pois: keys.filter(k => k.url.includes('refuges.info')).length,
        fountains: keys.filter(k => k.url.includes('overpass-api.de')).length,
      };
    });
    for (const [part, count] of Object.entries(cached)) {
      expect(count, `${part} missing from the bundle`).toBeGreaterThan(0);
    }

    // the badge survives a reopen: the state lives with the saved routes
    await page.reload();
    await page.waitForFunction(() => '__planner' in window);
    await page.locator('.topbar button', { hasText: /itinéraires|routes/i }).click();
    await expect(page.locator('[data-control="route-offline"].saved')).toBeVisible();
  });
});

test.describe('offline areas', () => {
  test('two overlapping areas are stored once, and deleting one keeps the other whole', async ({ page }) => {
    await page.route('**data.geopf.fr/**', route => route.fulfill({ body: 'tile' }));
    await page.route('**tile.openstreetmap.org/**', route => route.fulfill({ body: 'tile' }));
    await page.route('**refuges.info/**', route =>
      route.fulfill({ contentType: 'application/json', body: '{"features":[]}' }),
    );
    await page.route('**overpass-api.de/**', route =>
      route.fulfill({ contentType: 'application/json', body: '{"elements":[]}' }),
    );
    await openPlanner(page);

    const grab = async (center: [number, number], label: string) => {
      await page.evaluate(c => {
        (window as unknown as TestHandles).__map.jumpTo({ center: c, zoom: 14 });
      }, center);
      await page.locator('.topbar button', { hasText: /itinéraires|routes/i }).click();
      await page.locator('[data-control="area-download"]').click();
      await page.locator('.area-name-row input').fill(label);
      await page.locator('[data-control="area-confirm"]').click();
      await expect(page.locator('.area-list li', { hasText: label })).toBeVisible({ timeout: 60_000 });
      const cached = await page.evaluate(async () => (await (await caches.open('cairn-offline-v1')).keys()).length);
      await page.keyboard.press('Escape');
      return cached;
    };

    const afterFirst = await grab([2.435, 48.833], 'Vincennes');
    // a frame shifted by a fraction of the viewport: most of its tiles are the first one's
    const afterSecond = await grab([2.44, 48.834], 'Vincennes est');
    // the overlap is stored once: two bundles of the same size do not cost twice the entries
    expect(afterSecond).toBeGreaterThan(afterFirst);
    expect(afterSecond).toBeLessThan(afterFirst * 1.6);

    // and the total shown counts the shared zone once, not twice
    await page.locator('.topbar button', { hasText: /itinéraires|routes/i }).click();
    await expect(page.locator('[data-control="offline-total"]')).toContainText('2');

    // deleting the second leaves the first intact
    await page.locator('.area-list li', { hasText: 'Vincennes est' }).locator('.wp-remove').click();
    await expect(page.locator('.area-list li')).toHaveCount(1);
    const remaining = await page.evaluate(async () => (await (await caches.open('cairn-offline-v1')).keys()).length);
    expect(remaining).toBeGreaterThanOrEqual(afterFirst * 0.95);
  });
});

test.describe('qr handoff', () => {
  test('the share menu draws a scannable code of the short link', async ({ page }) => {
    await page.route('**/api/share', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'abc1234567' }) }),
    );
    await openPlanner(page);
    await page.locator('.segmented button', { hasText: /Manuel|Manual/ }).click();
    await clickAt(page, CEILLAC);
    await clickAt(page, FURTHER);
    await waitForRouting(page, 1);

    await page.locator('.topbar .menu-wrap button', { hasText: /Partager|Share/ }).click();
    await page.locator('[data-control="share-qr"]').click();
    const canvas = page.locator('[data-control="qr-canvas"]');
    await expect(canvas).toBeVisible();
    // a drawn code has black modules: a blank canvas would export as a near-empty png
    await expect
      .poll(() =>
        page.evaluate(() => {
          const el = document.querySelector<HTMLCanvasElement>('[data-control="qr-canvas"]');
          return el && el.width > 0 ? el.toDataURL('image/png').length : 0;
        }),
      )
      .toBeGreaterThan(2000);
    await page.keyboard.press('Escape');
    await expect(canvas).toBeHidden();
  });
});
