// the storms a real hand produces: races, drags past the edges, mid-flight switches
import { expect, test } from '@playwright/test';
import { CEILLAC, clickAt, openPlanner, planner, type TestHandles, waitForRouting } from './helpers';

const IGNORE = /tile|429|406|50[0-9]|AJAXError|data\.geopf\.fr|Failed to load resource|WebGL|GPU stall|ReadPixels|geolocation/i;

test.describe('interaction robustness', () => {
  let errors: string[];
  test.beforeEach(({ page }) => {
    errors = [];
    page.on('console', m => {
      if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(m.text().slice(0, 200));
    });
    page.on('pageerror', e => errors.push(e.message.slice(0, 200)));
  });

  test('undo storm while a leg is still routing never corrupts the model', async ({ page }) => {
    await openPlanner(page);
    await clickAt(page, CEILLAC);
    await clickAt(page, [CEILLAC[0] + 0.008, CEILLAC[1] + 0.001]);
    // no waiting: undo/redo race the in-flight routing
    await page.evaluate(() => {
      const s = (window as unknown as TestHandles).__planner.getState();
      for (let i = 0; i < 8; i++) {
        s.undo();
        s.redo();
      }
    });
    await waitForRouting(page, 1);
    const state = await planner(page).state();
    expect(state.anchorCount).toBe(2);
    expect(state.legCoordCounts).toHaveLength(1);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('switching presets mid-routing keeps exactly one leg per pair', async ({ page }) => {
    await openPlanner(page);
    await clickAt(page, CEILLAC);
    await clickAt(page, [CEILLAC[0] + 0.008, CEILLAC[1] + 0.001]);
    for (const preset of [/Plus court|Shortest/, /Plus rapide|Fastest/, /Équilibré|Balanced/]) {
      await page.locator('.side .segmented button', { hasText: preset }).click();
      await page.waitForTimeout(300);
    }
    await waitForRouting(page, 1);
    const state = await planner(page).state();
    expect(state.anchorCount).toBe(2);
    expect(state.legCoordCounts).toHaveLength(1);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('dragging a profile poi to the very ends stays inside the route', async ({ page }) => {
    await openPlanner(page);
    await page.locator('.segmented button', { hasText: /Manuel|Manual/ }).click();
    await clickAt(page, CEILLAC);
    await clickAt(page, [CEILLAC[0] + 0.008, CEILLAC[1] + 0.001]);
    await clickAt(page, [CEILLAC[0] + 0.008, CEILLAC[1] + 0.005]);
    await waitForRouting(page, 2);
    // the middle anchor becomes a poi so the chart shows a draggable marker
    await page.locator('.maplibregl-marker .anchor-marker').first().click();
    await page.locator('.kind-option', { hasText: /Sommet|Summit/ }).click();
    await page.keyboard.press('Escape');

    const marker = await page.locator('.chart-area .viz-poi').first().boundingBox();
    const chart = await page.locator('.chart-area svg').first().boundingBox();
    if (marker && chart) {
      await page.mouse.move(marker.x + marker.width / 2, marker.y + marker.height / 2);
      await page.mouse.down();
      // way past the left edge, then way past the right edge
      await page.mouse.move(chart.x - 80, marker.y, { steps: 6 });
      await page.mouse.move(chart.x + chart.width + 80, marker.y, { steps: 6 });
      await page.mouse.up();
      await waitForRouting(page, 2);
    }
    const state = await planner(page).state();
    expect(state.anchorCount).toBe(3);
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('scrubbing the chart during the flyover drives it without breaking it', async ({ page }) => {
    await openPlanner(page);
    await page.locator('.segmented button', { hasText: /Manuel|Manual/ }).click();
    await clickAt(page, CEILLAC);
    await clickAt(page, [CEILLAC[0] + 0.008, CEILLAC[1] + 0.001]);
    await waitForRouting(page, 1);
    await page.locator('[data-control="flyover"]').click();
    await page.waitForTimeout(1500);
    const chart = await page.locator('.chart-area svg').first().boundingBox();
    if (chart) {
      await page.mouse.move(chart.x + chart.width * 0.2, chart.y + chart.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(chart.x + chart.width * 0.8, chart.y + chart.height * 0.5, { steps: 10 });
      await page.mouse.up();
    }
    await page.waitForTimeout(800);
    await page.locator('[data-control="flyover-stop"]').click();
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('the date survives the camp being removed, and comes back with the next camp', async ({ page }) => {
    await openPlanner(page);
    await page.locator('.segmented button', { hasText: /Manuel|Manual/ }).click();
    await clickAt(page, CEILLAC);
    await clickAt(page, [CEILLAC[0] + 0.005, CEILLAC[1] + 0.001]);
    await clickAt(page, [CEILLAC[0] + 0.002, CEILLAC[1] + 0.005]);
    await waitForRouting(page, 2);
    await page.locator('.maplibregl-marker .anchor-marker').first().click();
    await page.locator('.kind-option', { hasText: /Bivouac|Camp/ }).click();
    await page.keyboard.press('Escape');
    const today = new Date().toISOString().slice(0, 10);
    await page.locator('.stages-date input').fill(today);
    // back to checkpoint: stages block goes, then the camp returns
    await page.locator('.wp-marker .poi-icon').first().click();
    await page.locator('.kind-option', { hasText: /Checkpoint/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-control="stages"]')).toHaveCount(0);
    await page.locator('.maplibregl-marker .anchor-marker').first().click();
    await page.locator('.kind-option', { hasText: /Bivouac|Camp/ }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.stages-date input')).toHaveValue(today);
    expect(errors, errors.join('\n')).toEqual([]);
  });
});
