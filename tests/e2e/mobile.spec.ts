import { expect, test } from '@playwright/test';
import { CEILLAC, openPlanner, planner, type TestHandles, waitForRouting } from './helpers';

// a phone has no right button and no cursor: the layout and the gestures both change.
// Chromium with touch emulation rather than a webkit device preset, so `make setup` keeps
// downloading a single browser; what is under test is our layout and our gestures.
test.use({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });

const NEARBY: [number, number] = [CEILLAC[0] + 0.008, CEILLAC[1] + 0.004];

/** taps a geographic position with a finger, letting maplibre do the projection */
async function tapAt(page: Parameters<typeof openPlanner>[0], lngLat: [number, number]): Promise<void> {
  const point = await page.evaluate(ll => (window as unknown as TestHandles).__map.project(ll), lngLat);
  const box = await page.locator('.maplibregl-canvas').boundingBox();
  if (!box) throw new Error('map canvas has no box');
  await page.touchscreen.tap(box.x + point.x, box.y + point.y);
}

test.describe('phone layout', () => {
  test('the map owns the screen, the panel becomes a bottom sheet', async ({ page }) => {
    await openPlanner(page);

    await expect(page.locator('.sheet')).toBeVisible();
    // the desktop split layout and its floating card are gone
    await expect(page.locator('.main')).toHaveCount(0);
    await expect(page.locator('.stats-card')).toHaveCount(0);

    const geometry = await page.evaluate(() => {
      const el = (sel: string) => document.querySelector(sel)?.getBoundingClientRect();
      return {
        topbarHeight: Math.round(el('.topbar')?.height ?? 0),
        mapHeight: Math.round(el('.map')?.height ?? 0),
        viewportHeight: window.innerHeight,
        overflowsSideways: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    // a single-line bar, and the map taking what is left
    expect(geometry.topbarHeight).toBeLessThan(60);
    expect(geometry.mapHeight).toBeGreaterThan(geometry.viewportHeight * 0.7);
    expect(geometry.overflowsSideways).toBe(false);
  });

  test('the sheet has three stops and only shows its header at rest', async ({ page }) => {
    await openPlanner(page);
    const heights: number[] = [];
    for (const index of [0, 1, 2]) {
      await page.locator('.sheet-stop').nth(index).click();
      await page.waitForTimeout(400);
      heights.push(await page.evaluate(() => Math.round(document.querySelector('.sheet')?.getBoundingClientRect().height ?? 0)));
    }
    expect(heights[0]).toBeLessThan(heights[1]);
    expect(heights[1]).toBeLessThan(heights[2]);

    await page.locator('.sheet-stop').nth(0).click();
    await expect(page.locator('.sheet-body')).toBeHidden();
    await expect(page.locator('.sheet-header')).toBeVisible();
  });

  test('map controls stay reachable above the sheet, and step aside when it takes over', async ({ page }) => {
    await openPlanner(page);
    const controlsClearOfSheet = () =>
      page.evaluate(() => {
        const controls = document.querySelector('.map-controls');
        const sheet = document.querySelector('.sheet')?.getBoundingClientRect();
        if (!controls || !sheet) return false;
        if (getComputedStyle(controls).display === 'none') return true;
        return controls.getBoundingClientRect().bottom <= sheet.top;
      });

    for (const index of [0, 1, 2]) {
      await page.locator('.sheet-stop').nth(index).click();
      await page.waitForTimeout(400);
      expect(await controlsClearOfSheet(), `stop ${index}`).toBe(true);
    }
  });

  test('tapping the grip cycles the stops, dragging it snaps to the nearest', async ({ page }) => {
    await openPlanner(page);
    const sheetClass = () => page.evaluate(() => document.querySelector('.sheet')?.className ?? '');
    const grip = page.locator('.sheet-grip');

    // the grip must be a real finger target, not a hairline
    expect(await grip.evaluate(el => Math.round(el.getBoundingClientRect().height))).toBeGreaterThanOrEqual(40);

    for (const expected of ['sheet-half', 'sheet-full', 'sheet-peek']) {
      const box = await grip.boundingBox();
      if (!box) throw new Error('no grip');
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(400);
      expect(await sheetClass()).toContain(expected);
    }

    const box = await grip.boundingBox();
    if (!box) throw new Error('no grip');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 260, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    expect(await sheetClass()).toContain('sheet-half');
  });

  test('a map panel stays on screen and never hides under the sheet', async ({ page }) => {
    await openPlanner(page);
    // open the sheet first: the panel must win the screen and push the sheet back down
    await page.locator('.sheet-stop').nth(1).click();
    await page.waitForTimeout(400);

    for (const control of ['layers', 'options']) {
      await page.locator(`[data-control="${control}"]`).click();
      await page.waitForTimeout(450);
      const fit = await page.evaluate(() => {
        const panel = document.querySelector('.mc-panel')?.getBoundingClientRect();
        const sheet = document.querySelector('.sheet')?.getBoundingClientRect();
        if (!panel || !sheet) return null;
        return {
          insideViewport: panel.top >= 0 && panel.bottom <= window.innerHeight,
          clearOfSheet: panel.bottom <= sheet.top,
        };
      });
      expect(fit, `panel ${control}`).toEqual({ insideViewport: true, clearOfSheet: true });
      await page.locator(`[data-control="${control}"]`).click();
      await page.waitForTimeout(250);
    }
  });

  test('actions hide behind one button that closes on an outside tap', async ({ page }) => {
    await openPlanner(page);
    await expect(page.locator('.menu-toggle')).toBeVisible();
    await expect(page.locator('.topbar-sheet.open')).toHaveCount(0);

    await page.locator('.menu-toggle').click();
    await expect(page.locator('.topbar-sheet.open')).toBeVisible();
    await expect(page.locator('.topbar-sheet.open')).toContainText(/routes|itinéraires/i);

    await tapAt(page, CEILLAC);
    await expect(page.locator('.topbar-sheet.open')).toHaveCount(0);

    // and the toggle itself closes what it opened: its own tap must not count as "outside",
    // or the close and the toggle cancel out and the menu looks stuck open
    await page.locator('.menu-toggle').tap();
    await expect(page.locator('.topbar-sheet.open')).toBeVisible();
    await page.locator('.menu-toggle').tap();
    await expect(page.locator('.topbar-sheet.open')).toHaveCount(0);
  });
});

test.describe('touch gestures', () => {
  test('a tap draws the route and the sheet header follows', async ({ page }) => {
    await openPlanner(page);
    await tapAt(page, CEILLAC);
    await tapAt(page, NEARBY);
    await waitForRouting(page, 1);

    expect((await planner(page).state()).anchorCount).toBe(2);
    await expect(page.locator('.sheet-header')).toContainText(/\d+(\.\d+)?\s*(m|km)/);
  });

  test('a long press drops a point of interest instead of a route point', async ({ page }) => {
    await openPlanner(page);
    const point = await page.evaluate(ll => (window as unknown as TestHandles).__map.project(ll), CEILLAC);
    const box = await page.locator('.maplibregl-canvas').boundingBox();
    if (!box) throw new Error('no canvas');

    await page.evaluate(
      ({ x, y }) => {
        const canvas = document.querySelector('.maplibregl-canvas') as HTMLElement;
        const touch = new Touch({ identifier: 1, target: canvas, clientX: x, clientY: y });
        canvas.dispatchEvent(new TouchEvent('touchstart', { touches: [touch], bubbles: true }));
      },
      { x: box.x + point.x, y: box.y + point.y },
    );
    await page.waitForTimeout(800);

    const state = await planner(page).state();
    expect(state.offRouteCount).toBe(1);
    // a long press must not also append a route point
    expect(state.anchorCount).toBe(0);
    await expect(page.locator('.point-editor')).toBeVisible();
  });
});

test.describe('phone features', () => {
  /** builds a two-point route through the store: a tap needs the map, this needs the route */
  async function routeOnPhone(page: Parameters<typeof openPlanner>[0]): Promise<void> {
    await openPlanner(page);
    await page.evaluate(pts => {
      const state = (window as unknown as TestHandles).__planner.getState() as unknown as {
        addAnchor(p: [number, number]): void;
      };
      for (const p of pts) state.addAnchor(p);
    }, [CEILLAC, NEARBY]);
    await waitForRouting(page, 1);
  }

  test('follow mode fits the screen above the sheet and stops from its own button', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await routeOnPhone(page);
    const onTrace = await page.evaluate(() => {
      const coords = (window as unknown as TestHandles).__planner.getState().legs[0].leg?.coords ?? [];
      const mid = coords[Math.floor(coords.length / 2)];
      return { longitude: mid[0], latitude: mid[1] };
    });
    await context.setGeolocation(onTrace);

    await page.locator('[data-control="follow"]').click();
    const bar = page.locator('[data-control="follow-bar"]');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText(/Prochain point|Next point/);

    const box = await bar.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) throw new Error('no geometry');
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    // clear of the sheet peek, so the two never overlap
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 80);

    await bar.locator('.follow-stop').click();
    await expect(bar).toBeHidden();
  });

  test('the share studio opens from the actions menu and escape closes it', async ({ page }) => {
    await routeOnPhone(page);
    await page.locator('.menu-toggle').click();
    await page.locator('.topbar .menu-wrap button', { hasText: /Partager|Share/ }).click();
    await page.locator('[data-control="share-image"]').click();
    await expect(page.locator('.share-panel')).toBeVisible();

    // two stacked widgets: the menu and the studio. Escape used to close only the menu, because
    // that re-render resubscribed the studio's listener mid-dispatch
    await page.keyboard.press('Escape');
    await expect(page.locator('.share-panel')).toBeHidden();
  });
});
