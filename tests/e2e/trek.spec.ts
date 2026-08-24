// the trek features: multi-day stages, weather, qr handoff, offline shell
import { expect, type Page, test } from '@playwright/test';
import { CEILLAC, clickAt, openPlanner, plantCamp, readDownload, type TestHandles, waitForRouting } from './helpers';

// all three inside the z14 viewport: a click projected past its edge lands on nothing
const FURTHER: [number, number] = [CEILLAC[0] + 0.008, CEILLAC[1] + 0.001];
const BEYOND: [number, number] = [CEILLAC[0] + 0.013, CEILLAC[1] + 0.005];

async function drawTrek(page: Page): Promise<void> {
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
    await expect(rows.first()).toContainText(/J1|D1/);
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
    await page.locator('[data-control="export-gpx"]').click();
    const body = await (await downloadPromise)
      .createReadStream()
      .then(stream => new Promise<string>(resolve => {
        let out = '';
        stream.on('data', (chunk: Buffer) => {
          out += chunk.toString();
        });
        stream.on('end', () => resolve(out));
      }));
    // named in the language the app is showing, since that is where the day prefix now lives
    expect(body).toMatch(/<name>[JD]1 · Bivouac du lac<\/name>/);
    expect(body).toMatch(/<name>[JD]2<\/name>/);
  });

  test('a trek can also leave as one file per day, zipped', async ({ page }) => {
    await drawTrek(page);
    await page.locator('.topbar button.primary', { hasText: /Exporter|Export/ }).click();
    const downloading = page.waitForEvent('download');
    await page.locator('[data-control="export-gpx-days"]').click();
    const file = await downloading;
    expect(file.suggestedFilename()).toMatch(/\.zip$/);

    // entries are stored, not deflated, so the archive carries its gpx in plain sight
    const bytes = await readDownload(file);
    expect(bytes.slice(0, 2)).toBe('PK');
    // read as raw bytes, so the separator between day and name is not compared
    expect(bytes).toContain('Bivouac du lac.gpx');
    expect(bytes).toMatch(/[JD]2\.gpx/);
    // the marker of day one rides in day one's file, not in tomorrow's
    expect(bytes.indexOf('<wpt')).toBeLessThan(bytes.indexOf('D2.gpx') > 0 ? bytes.indexOf('D2.gpx') : bytes.length);
    // each day is a file with its own single track, not the whole trek repeated
    expect(bytes.match(/<trk>/g)).toHaveLength(2);
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

test.describe('bivouac scoring', () => {
  /** ground photos are real data at Lac Miroir: mocked so each test picks the branch it asserts */
  async function mockGroundPhotos(page: Page, photos: unknown[]) {
    await page.route('**api.panoramax.xyz/**', route =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ features: photos }) }),
    );
  }

  /** a spring beside the route, so the water sub-score is deterministic */
  async function mockSpring(page: Page) {
    await page.route('**overpass-api.de/**', route => {
      const query = decodeURIComponent(route.request().url());
      const body = query.includes('spring')
        ? { elements: [{ type: 'node', lon: CEILLAC[0] + 0.004, lat: CEILLAC[1] + 0.001 }] }
        : { elements: [] };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
  }

  test('refines a planned camp, and moves it only when the card says so', async ({ page }) => {
    await mockSpring(page);
    await mockGroundPhotos(page, []);
    await openPlanner(page);
    await page.locator('.segmented button', { hasText: /Manuel|Manual/ }).click();
    await clickAt(page, CEILLAC);
    await clickAt(page, FURTHER);
    await clickAt(page, BEYOND);
    await waitForRouting(page, 2);

    await page.locator('[data-control="bivouac"]').click();
    // the search refines a plan: with no camp cut yet it says so instead of scoring the route
    await expect(page.locator('[data-control="bivouac-search"]')).toHaveCount(0);
    await page.locator('.bivouac-panel .mc-hint').first().waitFor();

    await plantCamp(page, 1, 'Nuit 1');
    await page.locator('[data-control="bivouac-search"]').click();
    const rows = page.locator('[data-control="bivouac-spot"]');
    await expect(rows.first()).toBeVisible({ timeout: 60_000 });
    // the suggestions hang under the night they belong to
    await expect(page.locator('.bivouac-group h3').first()).toContainText(/Nuit 1/);
    // every row says why it scored: altitude, slope, and the walk to water
    await expect(rows.first()).toContainText(/m/);
    await expect(rows.first()).toContainText(/pente|slope/);
    await expect(rows.first()).toContainText(/min/);
    expect(await page.locator('.bivouac-marker').count()).toBeGreaterThan(0);

    const before = await page.evaluate(
      () => (window as unknown as TestHandles).__planner.getState().anchors[1],
    );
    const target = await page.evaluate(
      () => (window as unknown as TestHandles).__planner.getState().bivouacSpots[0].point,
    );

    // a row opens the card and touches nothing: the camp is still where the hiker put it
    await rows.first().click();
    await expect(page.locator('[data-control="bivouac-card"]')).toBeVisible();
    // nobody photographed this spot: the card falls back to the aerial view of the exact tile
    await expect(page.locator('.bivouac-photo')).toHaveAttribute('src', /geopf\.fr/);
    await expect(page.locator('.bivouac-criteria li')).toHaveCount(5);
    const stillThere = await page.evaluate(
      () => (window as unknown as TestHandles).__planner.getState().anchors[1],
    );
    expect(stillThere.lon).toBeCloseTo(before.lon, 9);
    expect(stillThere.lat).toBeCloseTo(before.lat, 9);

    // the card's button is what moves it, to the exact spot that was scored
    await page.locator('[data-control="bivouac-move"]').click();
    await expect.poll(async () => {
      const camp = await page.evaluate(
        () => (window as unknown as TestHandles).__planner.getState().anchors[1],
      );
      return Math.abs(camp.lon - target[0]) < 1e-6 && Math.abs(camp.lat - target[1]) < 1e-6;
    }).toBe(true);
    // and being a camp, it still cuts the trek into stages
    await expect(page.locator('[data-control="stages"]')).toBeVisible();
  });

  test('shows the ground photo of a spot somebody walked past, with its distance and credit', async ({ page }) => {
    await mockSpring(page);
    await openPlanner(page);
    await page.locator('.segmented button', { hasText: /Manuel|Manual/ }).click();
    await clickAt(page, CEILLAC);
    await clickAt(page, FURTHER);
    await clickAt(page, BEYOND);
    await waitForRouting(page, 2);
    await plantCamp(page, 1, 'Nuit 1');

    await page.locator('[data-control="bivouac"]').click();
    await page.locator('[data-control="bivouac-search"]').click();
    const rows = page.locator('[data-control="bivouac-spot"]');
    await expect(rows.first()).toBeVisible({ timeout: 60_000 });

    // the photo is planted a hundred metres from the spot the search actually returned: only the
    // card asks Panoramax, so mocking it after the search is soon enough
    const spot = await page.evaluate(
      () => (window as unknown as TestHandles).__planner.getState().bivouacSpots[0].point,
    );
    await mockGroundPhotos(page, [
      {
        id: 'pic-1',
        geometry: { coordinates: [spot[0], spot[1] + 0.0009] },
        assets: { thumb: { href: 'https://panoramax.openstreetmap.fr/thumb.jpg' } },
        properties: { 'geovisio:producer': 'Patchi', license: 'CC-BY-SA-4.0' },
      },
    ]);
    await rows.first().click();

    await expect(page.locator('.bivouac-photo')).toHaveAttribute('src', /panoramax/);
    // the photo is near the spot, not of it: the card says whose it is and how far away
    const caption = page.locator('.bivouac-shot figcaption');
    await expect(caption).toContainText('Patchi');
    await expect(caption).toContainText('CC-BY-SA-4.0');
    await expect(caption).toContainText(/\d+\s?m/);
  });

  test('a search is kept until the route changes, and one night does not consume the others', async ({ page }) => {
    await mockSpring(page);
    await mockGroundPhotos(page, []);
    await openPlanner(page);
    // built through the store: a route long enough for two nights leaves the viewport
    await page.evaluate(center => {
      const s = (window as unknown as TestHandles).__planner;
      s.setState({ manualMode: true });
      s.getState().addAnchor(center);
      s.getState().addAnchor([center[0] + 0.02, center[1] + 0.004]);
      s.getState().addAnchor([center[0] + 0.05, center[1] + 0.008]);
      s.getState().addAnchor([center[0] + 0.07, center[1] + 0.012]);
    }, CEILLAC);
    await waitForRouting(page, 3);
    await plantCamp(page, 1, 'Nuit 1');
    await plantCamp(page, 2, 'Nuit 2');

    await page.locator('[data-control="bivouac"]').click();
    await page.locator('[data-control="bivouac-search"]').click();
    const rows = page.locator('[data-control="bivouac-spot"]');
    await expect(rows.first()).toBeVisible({ timeout: 60_000 });
    const found = await rows.count();
    expect(await page.locator('.bivouac-group').count()).toBe(2);

    // closing the panel keeps the search: reopening must not mean running it again
    await page.locator('[data-control="bivouac"]').click();
    await expect(page.locator('.bivouac-panel')).toHaveCount(0);
    await page.locator('[data-control="bivouac"]').click();
    await expect(rows).toHaveCount(found);

    // moving the first night spends its own suggestions and leaves the second night's standing
    const firstNight = await page.evaluate(
      () => (window as unknown as TestHandles).__planner.getState().bivouacSpots[0].campId,
    );
    const kept = await page.evaluate(
      campId =>
        (window as unknown as TestHandles).__planner
          .getState()
          .bivouacSpots.filter(spot => spot.campId !== campId).length,
      firstNight,
    );
    await rows.first().click();
    await page.locator('[data-control="bivouac-move"]').click();
    await expect(rows).toHaveCount(kept);
    await expect(page.locator('.bivouac-group')).toHaveCount(1);

    // editing the route drops them instead of showing spots scored for another itinerary,
    // the open card included: its button would move a night scored for another route
    await rows.first().click();
    await expect(page.locator('[data-control="bivouac-card"]')).toBeVisible();
    await page.evaluate(() => (window as unknown as TestHandles).__planner.getState().addAnchor([6.79, 44.64]));
    await expect(rows).toHaveCount(0);
    await expect(page.locator('.bivouac-marker')).toHaveCount(0);
    await expect(page.locator('[data-control="bivouac-card"]')).toHaveCount(0);
  });
});

test.describe('offline areas', () => {
  test('the downloaded zones can be seen on the map, and a trek can be unloaded', async ({ page }) => {
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
    await page.evaluate(() => (window as unknown as TestHandles).__planner.getState().saveCurrentRoute('Tour'));

    // download a framed area, and see it appear on the map through the option
    await page.locator('.topbar button', { hasText: /itinéraires|routes/i }).click();
    await page.locator('[data-control="area-download"]').click();
    await page.locator('.area-name-row input').fill('Ceillac');
    await page.locator('[data-control="area-confirm"]').click();
    await expect(page.locator('.area-list li', { hasText: 'Ceillac' })).toBeVisible({ timeout: 60_000 });
    // the preview comes from the bundle itself
    await expect(page.locator('.area-thumb').first()).toHaveAttribute('src', /tile\.openstreetmap\.org/);

    // a trek can be taken back off the device, and put back
    const offline = page.locator('[data-control="route-offline"]');
    await offline.click();
    await expect(page.locator('[data-control="route-offline"].saved')).toBeVisible({ timeout: 60_000 });
    await offline.click();
    await expect(page.locator('[data-control="route-offline"].saved')).toHaveCount(0);
    await expect(offline).toBeVisible();
    await page.keyboard.press('Escape');

    await page.locator('[data-control="options"]').click();
    await page
      .locator('.option-row', { hasText: /Zones hors-ligne|Downloaded offline/ })
      .locator('input[type="checkbox"]')
      .check();
    await page.keyboard.press('Escape');
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as unknown as TestHandles).__map.queryRenderedFeatures({ layers: ['overlay-offline-fill'] })
                .length,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
  });

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
