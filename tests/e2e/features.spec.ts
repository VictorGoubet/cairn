// one lean test per feature that had none: the golden-version net against regressions
import { expect, test } from '@playwright/test';
import { CEILLAC, clickAt, openPlanner, planner, type TestHandles, waitForRouting } from './helpers';

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
    await clickAt(page, [FURTHER[0] + 0.005, FURTHER[1]]);
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
      await page.locator('.export-menu button', { hasText: format }).click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toContain(extension);
      const body = await download
        .createReadStream()
        .then(stream => new Promise<string>(resolve => {
          let out = '';
          stream.on('data', (chunk: Buffer) => {
            out += chunk.toString();
          });
          stream.on('end', () => resolve(out));
        }));
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
      .locator('.option-row', { hasText: /Bornes|milestones|Kilometre/i })
      .locator('input[type="checkbox"]')
      .uncheck();
    await expect.poll(() => page.locator('.km-marker').count()).toBe(0);
  });

  test('slopes, GR trails and hidden paths switch their layers', async ({ page }) => {
    await openPlanner(page);
    await page.locator('[data-control="options"]').click();
    for (const [label, layerId] of [
      [/Pentes|Slopes/, 'overlay-slopes'],
      [/Sentiers balisés|Marked trails/, 'overlay-gr'],
      [/discrets|faint/i, 'overlay-hidden'],
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

test.describe('point editing', () => {
  test('a point takes a kind and a name, shown on its marker', async ({ page }) => {
    await drawManualRoute(page);
    await page.locator('.maplibregl-marker .anchor-marker').first().click();
    await expect(page.locator('.point-editor')).toBeVisible();
    await page.locator('.kind-option', { hasText: /eau|Water/ }).click();
    await page.locator('.point-name').fill('Fontaine du village');
    await page.keyboard.press('Escape');
    await expect(page.locator('.wp-label', { hasText: 'Fontaine du village' })).toBeVisible();
  });

  test('cut here from a middle point keeps the chosen half', async ({ page }) => {
    await drawManualRoute(page);
    await clickAt(page, [FURTHER[0] + 0.006, FURTHER[1] + 0.002]);
    await waitForRouting(page, 2);
    // the middle anchor: not the start, not the end
    await page.locator('.maplibregl-marker .anchor-marker').nth(1).click();
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
