// one lean test per feature that had none: the golden-version net against regressions
import { expect, test } from '@playwright/test';
import { CEILLAC, clickAt, openPlanner, planner, readDownload, type TestHandles, waitForRouting } from './helpers';

const FURTHER: [number, number] = [CEILLAC[0] + 0.016, CEILLAC[1] + 0.001];

async function drawRoute(page: import('@playwright/test').Page): Promise<void> {
  await openPlanner(page);
  await clickAt(page, CEILLAC);
  await clickAt(page, FURTHER);
  await waitForRouting(page, 1);
}

// most features are not the router: a manual route draws instantly and never flakes on brouter
async function drawManualRoute(page: import('@playwright/test').Page): Promise<void> {
  await openPlanner(page);
  await page.locator('.segmented button', { hasText: /Manuel|Manual/ }).click();
  await clickAt(page, CEILLAC);
  await clickAt(page, FURTHER);
  await waitForRouting(page, 1);
}

test.describe('route operations', () => {
  test('reverse swaps the endpoints', async ({ page }) => {
    await drawRoute(page);
    const before = await page.evaluate(() => (window as unknown as TestHandles).__planner.getState().anchors[0].lon);
    await page.locator('.side button', { hasText: /Inverser|Reverse/ }).click();
    await waitForRouting(page, 1);
    const after = await page.evaluate(() => (window as unknown as TestHandles).__planner.getState().anchors[0].lon);
    expect(after).not.toBe(before);
  });

  test('out and back doubles the distance and comes home', async ({ page }) => {
    await drawRoute(page);
    const oneWay = (await planner(page).state()).totalDistanceM;
    await page.locator('.side button', { hasText: /Aller-retour|Out and back/ }).click();
    await waitForRouting(page, 2);
    const state = await planner(page).state();
    expect(state.totalDistanceM).toBeGreaterThan(oneWay * 1.9);
    const anchors = await page.evaluate(() => (window as unknown as TestHandles).__planner.getState().anchors);
    expect(anchors[anchors.length - 1].lon).toBeCloseTo(anchors[0].lon, 6);
  });

  test('clear empties the route and undo brings it back', async ({ page }) => {
    await drawManualRoute(page);
    await page.locator('.side button', { hasText: /Effacer|Clear/ }).click();
    expect((await planner(page).state()).anchorCount).toBe(0);
    await page.evaluate(() => (window as unknown as TestHandles).__planner.getState().undo());
    expect((await planner(page).state()).anchorCount).toBe(2);
  });

  test('manual mode draws a straight leg with elevations, auto mode routes again', async ({ page }) => {
    await openPlanner(page);
    await page.locator('.segmented button', { hasText: /Manuel|Manual/ }).click();
    await clickAt(page, CEILLAC);
    await clickAt(page, FURTHER);
    await waitForRouting(page, 1);
    const manualLeg = await page.evaluate(() => (window as unknown as TestHandles).__planner.getState().legs[0]);
    expect(manualLeg.leg?.coords.length).toBeGreaterThanOrEqual(2);

    await page.locator('.segmented button', { hasText: /Auto/ }).click();
    // south of the line and west of the map-controls column, where a click reaches the canvas
    await clickAt(page, [CEILLAC[0] + 0.008, CEILLAC[1] - 0.003]);
    await waitForRouting(page, 2);
    const state = await planner(page).state();
    // the routed leg follows trails, so it carries far more vertices than a straight line
    expect(state.legCoordCounts[1]).toBeGreaterThan(state.legCoordCounts[0]);
  });

  test('switching the routing preset recomputes the legs', async ({ page }) => {
    await drawRoute(page);
    const balanced = (await planner(page).state()).totalDistanceM;
    await page.locator('.side .segmented button', { hasText: /Plus court|Shortest/ }).click();
    await waitForRouting(page, 1);
    const shortest = (await planner(page).state()).totalDistanceM;
    expect(shortest).toBeGreaterThan(0);
    expect(shortest).toBeLessThanOrEqual(balanced + 1);
  });
});

test.describe('exports', () => {
  for (const [format, extension, marker] of [
    ['GPX', '.gpx', '<gpx'],
    ['KML', '.kml', '<kml'],
    ['TCX', '.tcx', 'TrainingCenterDatabase'],
  ] as const) {
    test(`${format} download carries the route`, async ({ page }) => {
      await drawManualRoute(page);
      await page.locator('.topbar button', { hasText: /Exporter|Export/ }).click();
      const downloadPromise = page.waitForEvent('download');
      await page.locator(`[data-control="export-${format.toLowerCase()}"]`).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toContain(extension);
      const body = await readDownload(download);
      expect(body).toContain(marker);
    });
  }
});

test.describe('map options', () => {
  test('km badges follow their toggle', async ({ page }) => {
    await drawManualRoute(page);
    await expect.poll(() => page.locator('.km-marker').count()).toBeGreaterThan(0);
    await page.locator('[data-control="options"]').click();
    await page
      .locator('.option-row', { hasText: /Bornes|Kilometer/i })
      .locator('input[type="checkbox"]')
      .uncheck();
    await expect.poll(() => page.locator('.km-marker').count()).toBe(0);
  });

  test('slopes and GR trails switch their layers', async ({ page }) => {
    await openPlanner(page);
    await page.locator('[data-control="options"]').click();
    for (const [label, layerId] of [
      [/Pentes|Slopes/, 'overlay-slopes'],
      [/Sentiers balisés|Marked trails/, 'overlay-gr'],
    ] as const) {
      await page.locator('.option-row', { hasText: label }).locator('input[type="checkbox"]').check();
      const visibility = await page.evaluate(
        id => (window as unknown as TestHandles).__map.getLayoutProperty(id, 'visibility'),
        layerId,
      );
      expect(visibility, `${layerId} should be visible`).toBe('visible');
    }
  });
});

test.describe('where the maps stop', () => {
  test('a national map past its border says so, and switches in one tap', async ({ page }) => {
    await openPlanner(page);
    // Zermatt: the plan IGN draws nothing there, which looks broken rather than finished
    await page.evaluate(() => {
      (window as unknown as TestHandles).__map.jumpTo({ center: [7.75, 46.02], zoom: 13 });
    });
    const notice = page.locator('[data-control="coverage-switch"]');
    await expect(notice).toBeVisible();
    // it names the map that does cover the place, the neighbour's own rather than the world one
    await expect(notice).toContainText(/swisstopo/i);

    await notice.click();
    await expect.poll(async () => (await planner(page).state()).baseLayerId).toBe('swisstopo');
    await expect(notice).toHaveCount(0);

    // back over France, nothing to say
    await page.evaluate(() => {
      const state = (window as unknown as TestHandles).__planner.getState();
      state.setBaseLayerId('plan-ign');
      (window as unknown as TestHandles).__map.jumpTo({ center: [6.87, 45.92], zoom: 13 });
    });
    await expect(notice).toHaveCount(0);
  });
});

test.describe('international bases', () => {
  test('swisstopo draws real tiles over Zermatt', async ({ page }) => {
    await openPlanner(page);
    await page.evaluate(() => {
      (window as unknown as TestHandles).__map.jumpTo({ center: [7.74, 46.02], zoom: 13 });
    });
    await page.locator('[data-control="layers"]').click();
    await page.locator('.layer-card', { hasText: /Swisstopo/ }).click();
    const visibility = await page.evaluate(() =>
      (window as unknown as TestHandles).__map.getLayoutProperty('swisstopo', 'visibility'),
    );
    expect(visibility).toBe('visible');
    // tiles actually arrive from wmts.geo.admin.ch
    const gotTile = page.waitForResponse(res => res.url().includes('wmts.geo.admin.ch') && res.ok(), {
      timeout: 20_000,
    });
    await expect(gotTile).resolves.toBeTruthy();
  });

  test('ngi belgium draws real tiles over the Ardennes', async ({ page }) => {
    await openPlanner(page);
    await page.evaluate(() => {
      (window as unknown as TestHandles).__map.jumpTo({ center: [5.57, 50.35], zoom: 13 });
    });
    await page.locator('[data-control="layers"]').click();
    await page.locator('.layer-card', { hasText: /NGI/ }).click();
    // a transposed {x}/{y} template would 404 every tile here
    const gotTile = page.waitForResponse(res => res.url().includes('cartoweb.wmts.ngi.be') && res.ok(), {
      timeout: 20_000,
    });
    await expect(gotTile).resolves.toBeTruthy();
  });

  test('a place beyond the border is found through the fallback', async ({ page }) => {
    await openPlanner(page);
    await page.locator('.search-box input').fill('Zermatt');
    const row = page.locator('.search-results button, .search-result', { hasText: 'Zermatt' }).first();
    await expect(row).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('point editing', () => {
  test('a point takes a kind and a name, shown on its marker', async ({ page }) => {
    await drawManualRoute(page);
    // the ends wear flags now: the start flag opens the same editor a dot would
    await page.locator('.maplibregl-marker .anchor-flag').first().click();
    await expect(page.locator('.point-editor')).toBeVisible();
    await page.locator('.kind-option', { hasText: /eau|Water/ }).click();
    await page.locator('.point-name').fill('Fontaine du village');
    await page.keyboard.press('Escape');
    await expect(page.locator('.wp-label', { hasText: 'Fontaine du village' })).toBeVisible();
  });

  test('cut here from a middle point keeps the chosen half', async ({ page }) => {
    await drawManualRoute(page);
    await clickAt(page, [CEILLAC[0] + 0.008, CEILLAC[1] - 0.003]);
    await waitForRouting(page, 2);
    // the middle anchor: not the start, not the end
    await page.locator('.maplibregl-marker .anchor-marker').first().click();
    await expect(page.locator('.point-editor')).toBeVisible();
    await page.locator('[data-control="trim-before"]').click();
    const state = await planner(page).state();
    expect(state.anchorCount).toBe(2);
    expect(state.legCoordCounts).toHaveLength(1);
  });
});

test.describe('saved routes', () => {
  test('deleting a saved route removes it from the gallery only', async ({ page }) => {
    await drawManualRoute(page);
    await page.evaluate(() => (window as unknown as TestHandles).__planner.getState().saveCurrentRoute('à supprimer'));
    await page.locator('.topbar button', { hasText: /itinéraires|routes/i }).click();
    await expect(page.locator('.routes-grid')).toContainText('à supprimer');
    // first tap arms the confirmation, the second one deletes
    await page.locator('.route-remove').first().click();
    await page.locator('.route-remove.armed').first().click();
    await expect
      .poll(async () => (await planner(page).state()).savedRouteNames)
      .toEqual([]);
    // the drawn route itself is untouched
    expect((await planner(page).state()).anchorCount).toBe(2);
  });
});

test.describe('projects', () => {
  test('a project is picked in one tap, renamed, exported as one gpx and deleted whole', async ({ page }) => {
    await drawManualRoute(page);
    await page.evaluate(() => {
      (window as unknown as TestHandles).__planner.getState().saveCurrentRoute('62 km', 'Trail des Cretes');
    });

    // the second course reuses the project by tapping its chip, no typing
    await page.evaluate(() => (window as unknown as TestHandles).__planner.getState().clear());
    await clickAt(page, CEILLAC);
    await clickAt(page, [CEILLAC[0] + 0.008, CEILLAC[1] + 0.004]);
    await waitForRouting(page, 1);
    await page.locator('.save-btn').click();
    await page.locator('.save-name').fill('21 km');
    await page.locator('.chip', { hasText: 'Trail des Cretes' }).click();
    await page.locator('.save-pop .primary').click();
    await expect
      .poll(async () => (await planner(page).state()).savedRouteNames.length)
      .toBe(2);

    await page.locator('.topbar button', { hasText: /itinéraires|routes/i }).click();
    await expect(page.locator('.routes-group h4').first()).toContainText('Trail des Cretes');

    // one gpx for the whole project, one <trk> per course, which every planner reads
    const download = page.waitForEvent('download');
    await page.locator('[data-control="project-export"]').first().click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('Trail des Cretes.gpx');
    const body = await readDownload(file);
    expect(body).toContain('<name>62 km</name>');
    expect(body).toContain('<name>21 km</name>');

    // the whole project leaves in one go, arming first: no native dialog anywhere in this app
    await page.locator('[data-control="project-remove"]').first().click();
    await expect(page.locator('.group-remove.armed')).toHaveCount(1);
    // and it stays until confirmed, so a stray tap costs nothing
    await expect
      .poll(async () => (await planner(page).state()).savedRouteNames.length)
      .toBe(2);

    // renaming carries every course of the project with it
    await page.locator('[data-control="project-rename"]').first().click();
    await page.locator('.group-renaming input').fill('Cretes 2027');
    await page.locator('[data-control="project-rename-ok"]').click();
    await expect(page.locator('.routes-group h4').first()).toContainText('Cretes 2027');
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (window as unknown as TestHandles).__planner
              .getState()
              .savedRoutes.filter(r => r.collection === 'Cretes 2027').length,
        ),
      )
      .toBe(2);

    // confirmed: the courses of the project go, the ones outside it stay
    await page.evaluate(() => {
      (window as unknown as TestHandles).__planner.getState().saveCurrentRoute('Queyras');
    });
    await page.locator('[data-control="project-remove"]').first().click();
    await page.locator('[data-control="project-remove"]').first().click();
    await expect
      .poll(async () => (await planner(page).state()).savedRouteNames)
      .toEqual(['Queyras']);
  });
});

test.describe('offline zones', () => {
  test('tapping a downloaded zone frames it on the map', async ({ page }) => {
    await openPlanner(page);
    // one zone around the framed view, named by hand the way the panel asks
    await page.locator('.topbar button', { hasText: /itinéraires|routes/i }).click();
    await page.locator('[data-control="area-download"]').click();
    await page.locator('.area-name-row input').fill('Vincennes');
    await page.locator('[data-control="area-confirm"]').click();
    await expect(page.locator('.area-list li')).toHaveCount(1, { timeout: 60_000 });

    // moving away first, so framing the zone is visibly the panel's doing
    await page.evaluate(() => {
      (window as unknown as TestHandles).__map.jumpTo({ center: [2.35, 48.85], zoom: 8 });
    });
    await page.locator('[data-control="area-open"]').click();

    // the gallery gets out of the way, the layer comes on, and the camera lands on the zone
    await expect(page.locator('.routes-panel')).toHaveCount(0);
    await expect.poll(async () => (await planner(page).state()).overlays.offlineZones).toBe(true);
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const centre = (window as unknown as TestHandles).__map.getCenter();
          return Math.round(centre.lng * 10) / 10;
        }),
      )
      .toBeCloseTo(6.8, 0);
  });
});

test.describe('gallery thumbnails', () => {
  test('a card is drawn once, and reopening the gallery asks for no tile again', async ({ page }) => {
    await openPlanner(page);
    await page.evaluate(() => {
      (window as unknown as TestHandles).__planner.setState({ manualMode: true });
    });
    // three routes far enough apart that no two cards could share a tile
    for (let i = 0; i < 3; i++) {
      await page.evaluate(
        ({ center, index }) => {
          const state = (window as unknown as TestHandles).__planner.getState();
          state.clear();
          state.addAnchor([center[0] - index * 0.9, center[1] - index * 0.35]);
          state.addAnchor([center[0] - index * 0.9 + 0.05, center[1] - index * 0.35 + 0.03]);
        },
        { center: CEILLAC, index: i },
      );
      await waitForRouting(page, 1);
      await page.evaluate(index => {
        (window as unknown as TestHandles).__planner.getState().saveCurrentRoute(`route ${index}`);
      }, i);
    }

    let tiles = 0;
    page.on('request', request => {
      if (request.url().includes('geopf.fr/wmts')) tiles++;
    });
    const openGallery = () => page.locator('.topbar button', { hasText: /itinéraires|routes/i }).click();
    const drawn = () => page.locator('canvas.route-thumb:not(.loading)');

    await openGallery();
    await expect(drawn()).toHaveCount(3);
    expect(tiles).toBeGreaterThan(0);
    // the shapes show first and the map halves follow one at a time: the cache fills behind them
    const cached = () =>
      page.evaluate(() =>
        caches
          .open('cairn-thumbs-v1')
          .then(c => c.keys())
          .then(k => k.length),
      );
    await expect.poll(cached, { timeout: 60_000 }).toBe(3);

    // second open: the thumbnails come back from the cache, and the network is left alone
    await page.keyboard.press('Escape');
    tiles = 0;
    await openGallery();
    await expect(drawn()).toHaveCount(3);
    expect(tiles).toBe(0);

    // a reload used to start from nothing, which is what still felt slow: the store outlives it
    await page.reload();
    await page.waitForFunction(() => '__planner' in window);
    tiles = 0;
    await openGallery();
    await expect(drawn()).toHaveCount(3);
    expect(tiles).toBe(0);

    // a tile server that refuses must cost a gap in the picture, not the picture
    await page.route('**data.geopf.fr/wmts**', route => route.abort());
    await page.evaluate(async () => {
      await caches.delete('cairn-thumbs-v1');
    });
    await page.reload();
    await page.waitForFunction(() => '__planner' in window);
    await openGallery();
    await expect(drawn()).toHaveCount(3);
    await page.unroute('**data.geopf.fr/wmts**');

    // re-saving a route redraws it: a thumbnail must never outlive the geometry it shows
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const state = (window as unknown as TestHandles).__planner.getState();
      state.loadRoute(state.savedRoutes[0].id);
    });
    await page.evaluate(center => {
      (window as unknown as TestHandles).__planner.getState().addAnchor([center[0] + 0.06, center[1] + 0.04]);
    }, CEILLAC);
    await waitForRouting(page, 2);
    await page.evaluate(() => {
      const state = (window as unknown as TestHandles).__planner.getState();
      state.saveCurrentRoute(state.savedRoutes[0].name);
    });
    tiles = 0;
    await openGallery();
    await expect(drawn()).toHaveCount(3);
    expect(tiles).toBeGreaterThan(0);
  });
});

test.describe('hiker profile fields', () => {
  test('weight and pack change the energy estimate', async ({ page }) => {
    await drawManualRoute(page);
    const energyText = () => page.locator('.stat', { hasText: /kcal/ }).textContent();
    const before = await energyText();
    await page.locator('[data-control="options"]').click();
    const weight = page.locator('.profile-fields input').first();
    await weight.fill('95');
    await weight.blur();
    await expect.poll(energyText).not.toBe(before);
  });
});

test.describe('walking or running', () => {
  test('switching to running speeds up every estimate and follows the roadbook', async ({ page }) => {
    await drawManualRoute(page);
    // by its label, since a duration can read "45 min" or "2 h 10" and every stat is a number
    const estimate = page.locator('.stat').filter({ hasText: /Est\. time|Durée est/ });
    const hiking = await estimate.textContent();
    await page.locator('[data-control="options"]').click();
    await page.locator('.mc-panel .segmented button', { hasText: /Course|Running/ }).click();

    // the panel names the speed the pace buys, since the labels alone say nothing
    await expect(page.locator('.mc-panel .mc-hint', { hasText: 'km/h' })).toBeVisible();
    await expect.poll(async () => estimate.textContent()).not.toBe(hiking);
    // the pace names change with the mode: nobody strolls a trail race
    await expect(page.locator('.mc-panel .segmented.wrap')).toContainText(/Élite|Elite/);
  });
});

test.describe('a hiker who has measured themselves', () => {
  test('the custom profile prices the route with the three rates typed in', async ({ page }) => {
    await drawManualRoute(page);
    const estimate = page.locator('.stat').filter({ hasText: /Est\. time|Durée est/ });
    const preset = await estimate.textContent();

    await page.locator('[data-control="options"]').click();
    await page.locator('.mc-panel .segmented button', { hasText: /Perso|Custom/ }).click();
    // the pace names give way to the three rates: they would say nothing over them
    await expect(page.locator('.mc-panel .segmented.wrap')).toHaveCount(0);
    await expect(page.locator('[data-control="profile-flat"]')).toHaveValue('4.2');

    const flat = page.locator('[data-control="profile-flat"]');
    await flat.fill('2');
    await flat.blur();
    // half the flat speed on a route this flat means a visibly longer day
    await expect.poll(async () => estimate.textContent()).not.toBe(preset);

    // and the rates survive a reload, like the rest of the profile
    await page.reload();
    await page.waitForFunction(() => '__planner' in window);
    await page.locator('[data-control="options"]').click();
    await expect(page.locator('[data-control="profile-flat"]')).toHaveValue('2');
  });
});

test.describe('roadbook', () => {
  test('the export menu prints the route point by point', async ({ page }) => {
    await drawManualRoute(page);
    // a named landmark in the middle, which is what a roadbook is made of
    await page.evaluate(() => {
      const state = (window as unknown as TestHandles).__planner.getState();
      state.setEditing(state.anchors[1].id);
      state.updateEditingPoint('water', 'Fontaine du Cure');
    });
    await page.locator('.topbar button.primary', { hasText: /Export/ }).click();
    await page.locator('[data-control="export-roadbook"]').click();

    const sheet = page.locator('[data-control="roadbook"]');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.roadbook-table tbody tr')).toHaveCount(2);
    await expect(sheet).toContainText('Fontaine du Cure');
    // the clock column follows the departure time, and the shape of the route comes with it
    await expect(sheet.locator('.roadbook-table')).toContainText('07:00');
    await expect(sheet.locator('.roadbook-profile')).toBeVisible();
    // printing is the point, so the sheet must survive outside the app it is rendered from
    expect(await sheet.evaluate(el => el.closest('.app') === null)).toBe(true);
  });
});

test.describe('collections', () => {
  test('courses of one project are grouped, and the siblings show on the map', async ({ page }) => {
    await drawManualRoute(page);
    await page.evaluate(() => {
      const state = (window as unknown as TestHandles).__planner.getState();
      state.saveCurrentRoute('62 km', 'Trail des Cretes');
      state.clear();
    });
    await clickAt(page, CEILLAC);
    await clickAt(page, [CEILLAC[0] + 0.008, CEILLAC[1] + 0.004]);
    await waitForRouting(page, 1);
    await page.evaluate(() => (window as unknown as TestHandles).__planner.getState().saveCurrentRoute('21 km', 'Trail des Cretes'));

    await page.locator('.topbar button', { hasText: /itinéraires|routes/i }).click();
    await expect(page.locator('.routes-group h4').first()).toContainText('Trail des Cretes');
    // the heading counts the project rather than making the reader add up its cards
    await expect(page.locator('.routes-group h4 span').first()).toContainText('2');

    // the open course draws its sibling behind it, in the layer built for that
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (
              (window as unknown as TestHandles).__map.getStyle() as unknown as {
                sources: Record<string, { data?: { features?: unknown[] } }>;
              }
            ).sources['collection-siblings']?.data?.features?.length ?? 0,
        ),
      )
      .toBe(1);
  });
});
