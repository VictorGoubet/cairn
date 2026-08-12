import { expect, test } from '@playwright/test';

// Regression guard for a bug that already shipped: bundled without its worker, MapLibre
// renders a blank map and logs nothing at all. Counting successful tile requests catches it,
// since a broken worker means no tile is ever fetched.
test.describe('production build', () => {
  test('renders the map and loads tiles', async ({ page }) => {
    const errors: string[] = [];
    const tiles: string[] = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('response', r => {
      const url = r.url();
      if (r.ok() && /data\.geopf\.fr|tile\.openstreetmap\.org/.test(url)) tiles.push(url);
    });

    await page.goto('/');
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();
    await expect(page.locator('.side')).toBeVisible();

    // tile requests are the signal that bites: a broken worker fetches none, while the
    // canvas and the attribution control still show up
    await expect.poll(() => tiles.length, { timeout: 30_000 }).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('keeps the dev-only test handles out of the bundle', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();
    expect(await page.evaluate(() => '__map' in window || '__planner' in window)).toBe(false);
  });
});
