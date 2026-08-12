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
    await page.locator('.routes-wrap > button').click();
    await expect(page.locator('.routes-panel')).toBeVisible();

    await clickAt(page, CEILLAC);
    await expect(page.locator('.routes-panel')).toBeHidden();
    // the map click went through
    await page.waitForFunction(() => (window as unknown as TestHandles).__planner.getState().anchors.length === 1);
  });
});

test.describe('language', () => {
  test('the whole interface switches between french and english', async ({ page }) => {
    await openPlanner(page);
    await page.locator('.lang-seg button', { hasText: 'EN' }).click();
    await expect(page.locator('.side-section h2').first()).toHaveText('Route');
    await expect(page.locator('.search-box input')).toHaveAttribute('placeholder', /Search/);

    await page.locator('.lang-seg button', { hasText: 'FR' }).click();
    await expect(page.locator('.side-section h2').first()).toHaveText('Parcours');
    await expect(page.locator('.search-box input')).toHaveAttribute('placeholder', /Rechercher/);
  });
});
