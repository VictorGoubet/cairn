import { expect, test } from '@playwright/test';
import { CEILLAC, clickAt, openPlanner, planner, type TestHandles, waitForRouting } from './helpers';

const NEARBY: [number, number] = [CEILLAC[0] + 0.008, CEILLAC[1] + 0.004];
const FURTHER: [number, number] = [CEILLAC[0] + 0.016, CEILLAC[1] + 0.001];

test.describe('drawing a route', () => {
  test('two clicks give a routed track with live stats', async ({ page }) => {
    await openPlanner(page);
    await clickAt(page, CEILLAC);
    await clickAt(page, NEARBY);
    await waitForRouting(page, 1);

    const state = await planner(page).state();
    expect(state.anchorCount).toBe(2);
    // routing follows trails, so the geometry has far more vertices than the two clicks
    expect(state.legCoordCounts[0]).toBeGreaterThan(5);
    expect(state.totalDistanceM).toBeGreaterThan(200);

    await expect(page.locator('.stats-card')).toContainText(/\d+(\.\d+)?\s*(m|km)/);
    await expect(page.locator('.chart-area svg')).toBeVisible();
    await expect(page.locator('.bottom-panel .stat')).not.toHaveCount(0);
  });

  test('clicking the track inserts a checkpoint without redrawing the geometry', async ({ page }) => {
    await openPlanner(page);
    await clickAt(page, CEILLAC);
    await clickAt(page, FURTHER);
    await waitForRouting(page, 1);

    const before = await planner(page).state();
    const midpoint = await page.evaluate(() => {
      const coords = (window as unknown as TestHandles).__planner.getState().legs[0].leg?.coords ?? [];
      const mid = coords[Math.floor(coords.length / 2)];
      return [mid[0], mid[1]] as [number, number];
    });
    await clickAt(page, midpoint);
    await waitForRouting(page, 2);

    const after = await planner(page).state();
    expect(after.anchorCount).toBe(3);
    // the split shares its vertex, so the two halves total one vertex more than the original
    expect(after.legCoordCounts[0] + after.legCoordCounts[1]).toBe(before.legCoordCounts[0] + 1);
    // the halves are measured from the geometry while BRouter reported the original length,
    // so a fraction of a percent of difference is expected
    expect(after.totalDistanceM / before.totalDistanceM).toBeCloseTo(1, 2);
  });

  test('undo and redo walk back and forth through the edits', async ({ page }) => {
    await openPlanner(page);
    await clickAt(page, CEILLAC);
    await clickAt(page, NEARBY);
    await waitForRouting(page, 1);
    expect((await planner(page).state()).anchorCount).toBe(2);

    await planner(page).call('undo');
    expect((await planner(page).state()).anchorCount).toBe(1);
    await planner(page).call('redo');
    expect((await planner(page).state()).anchorCount).toBe(2);
  });

  test('the browser back button undoes, repeatedly, without leaving the app', async ({ page }) => {
    await openPlanner(page);
    for (const point of [CEILLAC, NEARBY, FURTHER]) {
      await clickAt(page, point);
      await page.waitForTimeout(400);
    }
    await waitForRouting(page, 2);
    expect((await planner(page).state()).anchorCount).toBe(3);

    await page.goBack();
    await page.waitForTimeout(500);
    expect((await planner(page).state()).anchorCount).toBe(2);
    await page.goBack();
    await page.waitForTimeout(500);
    expect((await planner(page).state()).anchorCount).toBe(1);
    // still on the planner, the sentinel history absorbed both navigations
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  });
});

test.describe('points of interest', () => {
  test('right-click drops an off-route point and opens its editor', async ({ page }) => {
    await openPlanner(page);
    await clickAt(page, CEILLAC, 'right');

    await expect(page.locator('.point-editor')).toBeVisible();
    await page.locator('.kind-option').filter({ hasText: /Water|eau/i }).click();
    await page.locator('.point-name').fill('Source du Mélezet');
    await page.locator('.point-editor .primary').click();

    const state = await planner(page).state();
    expect(state.offRouteCount).toBe(1);
    await expect(page.locator('.side .poi-list')).toContainText('Source du Mélezet');
    await expect(page.locator('.wp-marker')).toHaveCount(1);
  });

  test('one undo removes a freshly created point, editing included', async ({ page }) => {
    await openPlanner(page);
    await clickAt(page, CEILLAC, 'right');
    await page.locator('.kind-option').filter({ hasText: /Camp|Bivouac/i }).click();
    await page.locator('.point-name').fill('Bivouac');
    await page.locator('.point-editor .primary').click();
    expect((await planner(page).state()).offRouteCount).toBe(1);

    await planner(page).call('undo');
    expect((await planner(page).state()).offRouteCount).toBe(0);
    await expect(page.locator('.point-editor')).toBeHidden();
  });
});

test.describe('map layers and overlays', () => {
  test('contour lines and their elevation labels can be switched off', async ({ page }) => {
    await openPlanner(page);
    const contourLayersVisible = () =>
      page.evaluate(() => {
        const map = (window as unknown as TestHandles).__map;
        return map
          .getStyle()
          .layers.filter(l => /courbe/i.test(l.id) || l['source-layer'] === 'oro_courbe')
          .filter(l => map.getLayoutProperty(l.id, 'visibility') !== 'none').length;
      });

    expect(await contourLayersVisible()).toBeGreaterThan(0);
    await planner(page).call('toggleOverlay', 'contours');
    expect(await contourLayersVisible()).toBe(0);
    await planner(page).call('toggleOverlay', 'contours');
    expect(await contourLayersVisible()).toBeGreaterThan(0);
  });

  test('satellite keeps the vector labels and trails on top', async ({ page }) => {
    await openPlanner(page);
    await planner(page).call('setBaseLayerId', 'ortho');
    const visibleSymbols = await page.evaluate(() => {
      const map = (window as unknown as TestHandles).__map;
      return map
        .getStyle()
        .layers.filter(l => l.type === 'symbol')
        .filter(l => map.getLayoutProperty(l.id, 'visibility') !== 'none').length;
    });
    expect(visibleSymbols).toBeGreaterThan(0);
  });

  test('3D terrain switches hillshading on with it', async ({ page }) => {
    await openPlanner(page);
    await planner(page).call('toggleOverlay', 'terrain3d');
    const overlays = (await planner(page).state()).overlays;
    expect(overlays.terrain3d).toBe(true);
    expect(overlays.hillshade).toBe(true);

    // and hillshading stays independently switchable afterwards
    await planner(page).call('toggleOverlay', 'terrain3d');
    await planner(page).call('toggleOverlay', 'hillshade');
    expect((await planner(page).state()).overlays.hillshade).toBe(false);
  });

  test('holding the right button rotates and tilts the camera', async ({ page }) => {
    await openPlanner(page);
    const box = await page.locator('.maplibregl-canvas').boundingBox();
    if (!box) throw new Error('no canvas');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(cx + 90, cy - 90, { steps: 8 });
    const cursor = await page.evaluate(() => document.querySelector<HTMLElement>('.maplibregl-canvas')?.style.cursor);
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(300);

    expect(cursor).toContain('svg');
    const camera = await page.evaluate(() => {
      const map = (window as unknown as TestHandles).__map;
      return { bearing: map.getBearing(), pitch: map.getPitch() };
    });
    expect(Math.abs(camera.bearing) + camera.pitch).toBeGreaterThan(0);
    // the drag must not leave a stray point behind
    expect((await planner(page).state()).offRouteCount).toBe(0);
  });
});

test.describe('saving without an account', () => {
  test('a saved route survives a reload and can be reopened', async ({ page }) => {
    await openPlanner(page);
    await clickAt(page, CEILLAC);
    await clickAt(page, NEARBY);
    await waitForRouting(page, 1);

    await page.locator('.save-btn').click();
    await page.locator('.save-pop input').fill('Tour du Mélezet');
    await page.locator('.save-pop .primary').click();
    await expect(page.locator('.routes-wrap > button')).toContainText('(1)');

    await page.reload();
    await page.waitForFunction(() => '__planner' in window);
    // the draft comes back on its own
    await page.waitForFunction(() => (window as unknown as TestHandles).__planner.getState().anchors.length === 2);
    const state = await planner(page).state();
    expect(state.savedRouteNames).toContain('Tour du Mélezet');

    await page.locator('.routes-wrap > button').click();
    await page.locator('.route-load').first().click();
    await expect(page.locator('.routes-panel')).toBeHidden();
  });

  test('floating panels close when clicking elsewhere, without swallowing the click', async ({ page }) => {
    await openPlanner(page);
    await page.locator('[data-control="layers"]').click();
    await expect(page.locator('.mc-panel')).toBeVisible();

    await clickAt(page, CEILLAC);
    await expect(page.locator('.mc-panel')).toBeHidden();
    // the map click went through
    await page.waitForFunction(() => (window as unknown as TestHandles).__planner.getState().anchors.length === 1);
  });

  test('the routes gallery is a modal: the backdrop closes it and keeps the click', async ({ page }) => {
    await openPlanner(page);
    await page.locator('.routes-wrap > button').click();
    await expect(page.locator('.routes-panel')).toBeVisible();

    // a click on the backdrop, well clear of the centered panel
    await page.mouse.click(40, 400);
    await expect(page.locator('.routes-panel')).toBeHidden();
    expect((await planner(page).state()).anchorCount).toBe(0);
  });
});

test.describe('reading the route', () => {
  test('selecting a stretch on the profile highlights it on the map', async ({ page }) => {
    await openPlanner(page);
    await clickAt(page, CEILLAC);
    await clickAt(page, FURTHER);
    await waitForRouting(page, 1);

    const highlighted = () =>
      page.evaluate(() => (window as unknown as TestHandles).__map.queryRenderedFeatures({ layers: ['profile-selection'] }).length);
    expect(await highlighted()).toBe(0);

    const rect = page.locator('.chart-area rect[fill="transparent"]');
    const box = await rect.boundingBox();
    if (!box) throw new Error('no chart');
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();

    await expect(page.locator('.selection-chip')).toBeVisible();
    await expect.poll(highlighted).toBeGreaterThan(0);

    await page.locator('.selection-chip').click();
    await expect.poll(highlighted).toBe(0);
  });

  test('the play button flies the route in 3D, escape brings the map back', async ({ page }) => {
    await openPlanner(page);
    await clickAt(page, CEILLAC);
    await clickAt(page, FURTHER);
    await waitForRouting(page, 1);

    const camera = () =>
      page.evaluate(() => {
        const map = (window as unknown as TestHandles).__map;
        const center = map.getCenter();
        return {
          pitch: Math.round(map.getPitch()),
          lng: center.lng,
          lat: center.lat,
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          terrain: map.getTerrain() !== null,
        };
      });

    await page.locator('[data-control="flyover"]').click();

    // pause first, before the flight has time to end under a slow CI: the play button toggles
    // the mode, and only the dedicated stop button or escape closes the view
    const paused = () =>
      page.evaluate(
        () =>
          ((window as unknown as TestHandles).__planner.getState() as unknown as { flyoverPaused: boolean })
            .flyoverPaused,
      );
    await page.locator('[data-control="flyover"]').click();
    await expect.poll(paused).toBe(true);
    await expect(page.locator('[data-control="flyover-stop"]')).toBeVisible();
    await page.locator('[data-control="flyover"]').click();
    await expect.poll(paused).toBe(false);

    // a clearly tilted 3D chase: the exact cruise pitch depends on the relief the camera clears
    await expect.poll(async () => (await camera()).pitch, { timeout: 10_000 }).toBeGreaterThan(35);
    const flying = await camera();
    expect(flying.terrain).toBe(true);
    // the grazing framing: a pitch sitting on the 85 degree cap means the camera looks uphill
    // into the sky instead of onto the route. Hairpins pull the camera closer to the dot (the
    // chord shrinks) so the zoom breathes a little; past 16.8 it is a derived-zoom blowup.
    expect(flying.pitch).toBeLessThan(84);
    expect(flying.zoom).toBeLessThan(16.8);
    // the glowing dot rides the route for the duration of the flight
    const dotVisible = () =>
      page.evaluate(() =>
        (window as unknown as TestHandles).__map.getStyle().layers.some(l => l.id === 'flyover-dot-core'),
      );
    expect(await dotVisible()).toBe(true);
    // and its twin walks the elevation profile
    await expect(page.locator('.viz-flyover-dot')).toBeVisible({ timeout: 10_000 });

    // the flight waits briefly for tiles before taking off, then the view keeps evolving. On a
    // short route the look-at point settles on the finish, so the framing moves through zoom
    // and bearing rather than through the center alone.
    await expect
      .poll(
        async () => {
          const later = await camera();
          return (
            Math.abs(later.lng - flying.lng) +
            Math.abs(later.lat - flying.lat) +
            Math.abs(later.zoom - flying.zoom) +
            Math.abs(later.bearing - flying.bearing)
          );
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    await page.keyboard.press('Escape');
    await expect.poll(async () => (await camera()).pitch, { timeout: 10_000 }).toBeLessThan(20);
    expect((await camera()).terrain).toBe(false);
    expect(await dotVisible()).toBe(false);
    await expect(page.locator('[data-control="flyover-stop"]')).toBeHidden();
  });

  test('escape closes an open panel', async ({ page }) => {
    await openPlanner(page);
    await page.locator('[data-control="options"]').click();
    await expect(page.locator('.mc-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.mc-panel')).toHaveCount(0);
  });

  test('the middle button rotates and tilts the camera', async ({ page }) => {
    await openPlanner(page);
    const box = await page.locator('.maplibregl-canvas').boundingBox();
    if (!box) throw new Error('no canvas');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;

    const camera = () =>
      page.evaluate(() => {
        const map = (window as unknown as TestHandles).__map;
        return { bearing: Math.round(map.getBearing()), pitch: Math.round(map.getPitch()) };
      });

    await page.mouse.move(cx, cy);
    await page.mouse.down({ button: 'middle' });
    // a generous drag in both axes, applied in small steps so no single move is swallowed
    await page.mouse.move(cx + 160, cy - 140, { steps: 20 });
    const cursor = await page.evaluate(() => document.querySelector<HTMLElement>('.maplibregl-canvas')?.style.cursor);
    await expect.poll(async () => Math.abs((await camera()).bearing)).toBeGreaterThan(10);
    await expect.poll(async () => (await camera()).pitch).toBeGreaterThan(10);
    await page.mouse.up({ button: 'middle' });

    expect(cursor).toContain('svg');
  });

  test('points can be reordered, and the legs around them are recomputed', async ({ page }) => {
    await openPlanner(page);
    for (const point of [CEILLAC, NEARBY, FURTHER]) {
      await clickAt(page, point);
      await page.waitForTimeout(400);
    }
    await waitForRouting(page, 2);

    // the handle is what makes the row draggable, and it must be there
    await expect(page.locator('.anchor-list .drag-handle').first()).toBeVisible();

    const names = () =>
      page.evaluate(() => (window as unknown as TestHandles).__planner.getState().anchors.map(a => a.id));
    const before = await names();
    await page.evaluate(() => {
      const state = (window as unknown as TestHandles).__planner.getState() as unknown as {
        reorderAnchor(from: number, to: number): void;
      };
      state.reorderAnchor(0, 2);
    });
    const after = await names();
    expect(after).toEqual([before[1], before[2], before[0]]);

    await waitForRouting(page, 2);
    const state = await planner(page).state();
    expect(state.anchorCount).toBe(3);
    expect(state.legCoordCounts.every(count => count > 1)).toBe(true);
  });
});

test.describe('editing from the profile', () => {
  test('the wheel zooms the profile and the chip resets it', async ({ page }) => {
    await openPlanner(page);
    await clickAt(page, CEILLAC);
    await clickAt(page, FURTHER);
    await waitForRouting(page, 1);

    const chart = page.locator('.chart-area');
    await chart.hover();
    await page.mouse.wheel(0, -240);
    await expect(page.locator('.chart-zoom-reset')).toBeVisible();
    // the x axis now starts inside the route
    await expect(page.locator('.chart-area .viz-tick').filter({ hasText: 'km' }).first()).not.toHaveText('0 km');
    await page.locator('.chart-zoom-reset').click();
    await expect(page.locator('.chart-zoom-reset')).toBeHidden();
  });

  test('double-click inserts a point, its marker edits on click and slides on drag', async ({ page }) => {
    await openPlanner(page);
    await clickAt(page, CEILLAC);
    await clickAt(page, FURTHER);
    await waitForRouting(page, 1);

    // double-click on the profile inserts a route point there and opens its editor
    const rect = page.locator('.chart-area rect[fill="transparent"]');
    await rect.dblclick();
    await expect(page.locator('.point-editor')).toBeVisible();
    await page.waitForFunction(() => (window as unknown as TestHandles).__planner.getState().anchors.length === 3);

    // a summit kind makes it a profile marker
    await page.locator('.kind-grid .kind-option').nth(6).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.point-editor')).toBeHidden();
    const hit = page.locator('.viz-poi-hit');
    await expect(hit).toHaveCount(1);

    // sliding the marker moves the anchor along the trail
    const before = await page.evaluate(() => {
      const a = (window as unknown as TestHandles).__planner.getState().anchors[1];
      return [a.lon, a.lat];
    });
    const box = await hit.boundingBox();
    if (!box) throw new Error('no hit box');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await waitForRouting(page, 2);
    const after = await page.evaluate(() => {
      const a = (window as unknown as TestHandles).__planner.getState().anchors[1];
      return [a.lon, a.lat];
    });
    expect(after).not.toEqual(before);

    // a plain click on the marker reopens its editor
    await hit.click();
    await expect(page.locator('.point-editor')).toBeVisible();
  });
});

test.describe('importing gpx', () => {
  const trackFile = (name: string, lonFrom: number) => ({
    name: `${name}.gpx`,
    mimeType: 'application/gpx+xml',
    buffer: Buffer.from(
      `<?xml version="1.0"?><gpx version="1.1"><trk><name>${name}</name><trkseg>` +
        Array.from(
          { length: 12 },
          (_, i) =>
            `<trkpt lat="${CEILLAC[1] + i * 0.0004}" lon="${lonFrom + i * 0.0006}"><ele>${1800 + i * 10}</ele></trkpt>`,
        ).join('') +
        `</trkseg></trk></gpx>`,
    ),
  });

  test('two tracks merge into one itinerary', async ({ page }) => {
    await openPlanner(page);
    await page.locator('input[type="file"]').setInputFiles([
      trackFile('first', CEILLAC[0]),
      trackFile('second', CEILLAC[0] + 0.008),
    ]);
    await page.waitForFunction(() => (window as unknown as TestHandles).__planner.getState().anchors.length >= 2);
    const state = await planner(page).state();
    // both files are in: the merged trace is longer than either half
    expect(state.totalDistanceM).toBeGreaterThan(1500);
  });

  test('beeline legs become real paths on demand', async ({ page }) => {
    await openPlanner(page);
    // a sketch: three points joined by straight lines, which is what a cache list looks like
    await page.locator('input[type="file"]').setInputFiles({
      name: 'caches-line.gpx',
      mimeType: 'application/gpx+xml',
      buffer: Buffer.from(
        `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>` +
          `<trkpt lat="44.6318" lon="6.7752"><ele>1650</ele></trkpt>` +
          `<trkpt lat="44.6400" lon="6.7850"><ele>1800</ele></trkpt>` +
          `<trkpt lat="44.6465" lon="6.7920"><ele>1900</ele></trkpt>` +
          `</trkseg></trk></gpx>`,
      ),
    });
    await page.waitForFunction(() => (window as unknown as TestHandles).__planner.getState().anchors.length >= 2);
    const straight = await planner(page).state();

    await page.locator('[data-control="route-straight"]').click();
    // the router answers with real geometry: many more vertices than the three imported points
    await expect
      .poll(async () => (await planner(page).state()).legCoordCounts.reduce((a, b) => a + b, 0), { timeout: 30_000 })
      .toBeGreaterThan(straight.legCoordCounts.reduce((a, b) => a + b, 0) + 10);
    await expect(page.locator('[data-control="route-straight"]')).toBeHidden();
  });

  test('a waypoints-only export lands as markers and keeps the current route', async ({ page }) => {
    await openPlanner(page);
    await clickAt(page, CEILLAC);
    await clickAt(page, FURTHER);
    await waitForRouting(page, 1);
    const before = await planner(page).state();

    // what geocaching.com hands out for a set of caches: waypoints, no track
    await page.locator('input[type="file"]').setInputFiles({
      name: 'caches.gpx',
      mimeType: 'application/gpx+xml',
      buffer: Buffer.from(
        `<?xml version="1.0"?><gpx version="1.1">` +
          `<wpt lat="44.641" lon="6.781"><name>GC1ABCD Cache du col</name><sym>Geocache</sym></wpt>` +
          `<wpt lat="44.646" lon="6.792"><name>GC2EFGH Cache du lac</name><sym>Geocache</sym></wpt>` +
          `</gpx>`,
      ),
    });
    await page.waitForFunction(() => (window as unknown as TestHandles).__planner.getState().offRoutePoints.length === 2);
    const after = await planner(page).state();
    expect(after.anchorCount).toBe(before.anchorCount);
    expect(after.totalDistanceM).toBeCloseTo(before.totalDistanceM, 0);
    await expect(page.locator('.side .poi-list:not(.anchor-list)')).toContainText('Cache du col');
  });
});

test.describe('hiker profile', () => {
  test('the pace changes every duration, and survives a reload', async ({ page }) => {
    await openPlanner(page);
    await clickAt(page, CEILLAC);
    await clickAt(page, FURTHER);
    await waitForRouting(page, 1);

    const duration = () => page.locator('.bottom-panel .stat', { hasText: /Est. time|Durée/ }).innerText();
    const steady = await duration();
    await expect(page.locator('.bottom-panel .stat', { hasText: /Energy|Énergie/ })).toContainText('kcal');

    await page.locator('[data-control="options"]').click();
    await page.locator('.mc-panel .segmented button', { hasText: /Athletic|Athlétique/ }).click();
    // an athlete walks the same line quicker: the estimate has to move
    await expect.poll(duration).not.toBe(steady);
    const athletic = await duration();

    await page.reload();
    await page.waitForFunction(() => '__planner' in window);
    await page.waitForFunction(() => (window as unknown as TestHandles).__planner.getState().anchors.length === 2);
    await expect.poll(duration).toBe(athletic);
  });
});

test.describe('follow mode', () => {
  test('the bar tracks the position along the route and warns when off it', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await openPlanner(page);
    await clickAt(page, CEILLAC);
    await clickAt(page, FURTHER);
    await waitForRouting(page, 1);
    // a point on the trace, and one clearly beside it, both read from the routed geometry
    const { onTrace, aside } = await page.evaluate(() => {
      const coords = (window as unknown as TestHandles).__planner.getState().legs[0].leg?.coords ?? [];
      const mid = coords[Math.floor(coords.length / 2)];
      return { onTrace: { longitude: mid[0], latitude: mid[1] }, aside: { longitude: mid[0], latitude: mid[1] + 0.005 } };
    });

    await context.setGeolocation(onTrace);
    await page.locator('[data-control="follow"]').click();
    const bar = page.locator('[data-control="follow-bar"]');
    await expect(bar).toBeVisible();
    // a real reading, not the "permission denied" message (whose text also contains an "m")
    await expect(bar).toContainText(/Prochain point|Next point/);
    await expect(bar).toContainText(/\d[\d.]*\s?(km|m)\b/);
    await expect(bar).not.toContainText(/Hors|Off route/);

    // 550 m off the trail: the bar says so instead of pretending
    await context.setGeolocation(aside);
    await expect(bar).toContainText(/Hors|Off route/, { timeout: 20_000 });

    await bar.locator('.follow-stop').click();
    await expect(bar).toBeHidden();
  });

  test('following and the flyover never run at once', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ longitude: CEILLAC[0], latitude: CEILLAC[1] });
    await openPlanner(page);
    await clickAt(page, CEILLAC);
    await clickAt(page, FURTHER);
    await waitForRouting(page, 1);

    await page.locator('[data-control="follow"]').click();
    await expect(page.locator('[data-control="follow-bar"]')).toBeVisible();
    await page.locator('[data-control="flyover"]').click();
    await expect(page.locator('[data-control="follow-bar"]')).toBeHidden();
  });
});

test.describe('search as a route builder', () => {
  test('typed coordinates become a route point, twice over', async ({ page }) => {
    await openPlanner(page);
    const input = page.locator('.search-box input');

    // the geocaching notation, answered locally with no geocoder involved
    await input.fill('N 44° 37.908 E 006° 46.512');
    await expect(page.locator('.search-results .result-name')).toHaveText('44.63180, 6.77520');
    await page.locator('.result-add').click();
    await page.waitForFunction(() => (window as unknown as TestHandles).__planner.getState().anchors.length === 1);

    // a second cache, in plain decimal: the two points get routed together
    await input.fill('44.6465, 6.7920');
    await page.locator('.result-add').click();
    await waitForRouting(page, 1);
    const state = await planner(page).state();
    expect(state.anchorCount).toBe(2);
    expect(state.totalDistanceM).toBeGreaterThan(500);
  });

  test('a place is centered by the row and appended by the plus', async ({ page }) => {
    await openPlanner(page);
    await page.locator('.search-box input').fill('Ceillac');
    await expect(page.locator('.search-results li').first()).toBeVisible();
    await page.locator('.search-results .result-go').first().click();
    // centering leaves the itinerary alone
    expect((await planner(page).state()).anchorCount).toBe(0);
  });
});

test.describe('hikes around', () => {
  // Overpass is a volunteer-run API: the fixture keeps the test honest about our own code
  const RELATION_ID = 1234;
  const LIST = {
    elements: [
      { type: 'relation', id: RELATION_ID, tags: { name: 'Tour du Queyras', ref: 'GR58', network: 'nwn', distance: '130' } },
      { type: 'relation', id: 7, tags: { name: 'Sentier du Mélezet', network: 'lwn' } },
    ],
  };
  const GEOMETRY = {
    elements: [
      {
        type: 'relation',
        id: RELATION_ID,
        members: [
          {
            type: 'way',
            role: '',
            geometry: Array.from({ length: 40 }, (_, i) => ({ lon: CEILLAC[0] + i * 0.0004, lat: CEILLAC[1] + i * 0.0002 })),
          },
          { type: 'node', role: 'guidepost', lon: CEILLAC[0], lat: CEILLAC[1] },
        ],
      },
    ],
  };

  test('lists marked routes in view and loads one as the itinerary', async ({ page }) => {
    await page.route('**/overpass-api.de/api/interpreter', async route => {
      const body = route.request().postData() ?? '';
      const payload = body.includes('out%20geom') || body.includes('out geom') ? GEOMETRY : LIST;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
    });
    await openPlanner(page);

    await page.locator('[data-control="explore"]').click();
    await expect(page.locator('.nearby-list button')).toHaveCount(2);
    // local first: what is walkable from here outranks the national traversal passing through
    await expect(page.locator('.nearby-list button').first()).toContainText('Sentier du Mélezet');
    const queyras = page.locator('.nearby-list button').nth(1);
    await expect(queyras).toContainText('Tour du Queyras');
    await expect(queyras.locator('.nearby-ref')).toHaveText('GR58');
    await expect(queyras).toContainText('130.0 km');
    // opening the panel turns the marked-trail tiles on, so the list has a visual counterpart
    expect((await planner(page).state()).overlays.gr).toBe(true);

    await queyras.click();
    await page.waitForFunction(() => (window as unknown as TestHandles).__planner.getState().anchors.length >= 2);
    const state = await planner(page).state();
    expect(state.totalDistanceM).toBeGreaterThan(1000);
    // the loaded route names itself, which is what the share tile and the save dialog reuse
    await expect(page.locator('.mc-panel')).toBeHidden();
  });
});

test.describe('sharing an image', () => {
  test('the studio composes a tile and keeps it exportable', async ({ page }) => {
    await openPlanner(page);
    await clickAt(page, CEILLAC);
    await clickAt(page, FURTHER);
    await waitForRouting(page, 1);

    await page.locator('.topbar .menu-wrap button', { hasText: /Partager|Share/ }).click();
    await page.locator('[data-control="share-image"]').click();
    await expect(page.locator('.share-panel')).toBeVisible();

    // the night preset needs no network, so the render is deterministic
    await page.locator('[data-control="share-next"]').click();
    await page.locator('[data-control="share-next"]').click();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const canvas = document.querySelector<HTMLCanvasElement>('[data-control="share-canvas"]');
            if (!canvas || canvas.width === 0) return 0;
            // an exportable, non-blank canvas: tainting or an empty draw would fail both checks
            return canvas.toDataURL('image/png').length;
          }),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(30_000);

    // story format re-renders at the taller size
    await page.locator('.share-head .segmented button').nth(1).click();
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector<HTMLCanvasElement>('[data-control="share-canvas"]')?.height ?? 0),
      )
      .toBe(1920);

    await page.keyboard.press('Escape');
    await expect(page.locator('.share-panel')).toBeHidden();
  });
});

test.describe('language', () => {
  test('the whole interface switches between french and english', async ({ page }) => {
    await openPlanner(page);
    await page.locator('.lang-seg button', { hasText: 'EN' }).click();
    await expect(page.locator('.side-section h2').first()).toHaveText('Route');
    await expect(page.locator('.search-box input')).toHaveAttribute('placeholder', /coordinates/);

    await page.locator('.lang-seg button', { hasText: 'FR' }).click();
    await expect(page.locator('.side-section h2').first()).toHaveText('Parcours');
    await expect(page.locator('.search-box input')).toHaveAttribute('placeholder', /coordonnées/);
  });
});
