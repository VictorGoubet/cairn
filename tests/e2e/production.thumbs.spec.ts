// the gallery on the built site, service worker included: the difference the dev server hides is
// that a worker activation deletes every cache it was not told to keep
import { expect, test } from '@playwright/test';

const ROUTES_KEY = 'cairn.routes.v1';
const THUMB_CACHE = 'cairn-thumbs-v1';

test('thumbnails are drawn once and kept by the worker', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);

  // four routes far enough apart that no two cards could share a tile, in the shape storage keeps
  await page.evaluate(key => {
    const routes = Array.from({ length: 4 }, (_, i) => {
      const lon = 6.78 - i * 0.9;
      const lat = 44.63 - i * 0.35;
      const coords = Array.from({ length: 80 }, (_, j) => [
        Number((lon + j * 0.0004).toFixed(6)),
        Number((lat + j * 0.0002).toFixed(6)),
        1500 + (j % 40) * 8,
      ]);
      return {
        id: `seed-${i}`,
        name: `route ${i}`,
        updatedAt: '2026-08-24T06:00:00.000Z',
        distanceM: 5000,
        gainM: 320,
        anchors: [
          { id: `a-${i}`, lon: coords[0][0], lat: coords[0][1], kind: 'checkpoint', name: '' },
          { id: `b-${i}`, lon: coords[79][0], lat: coords[79][1], kind: 'checkpoint', name: '' },
        ],
        legs: [{ id: `l-${i}`, manual: true, leg: { coords, distanceM: 5000 } }],
        offRoutePoints: [],
      };
    });
    localStorage.setItem(key, JSON.stringify(routes));
  }, ROUTES_KEY);

  // the store reads localStorage at boot, so the seed reaches the app through a reload
  await page.reload();
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();

  let tiles = 0;
  page.on('request', request => {
    if (request.url().includes('geopf.fr/wmts')) tiles++;
  });
  const openGallery = () => page.locator('.topbar button', { hasText: /itinéraires|routes/i }).click();
  const drawn = () => page.locator('canvas.route-thumb:not(.loading)');

  await openGallery();
  await expect(drawn()).toHaveCount(4, { timeout: 60_000 });
  expect(tiles).toBeGreaterThan(0);

  // the canvas has to stay readable, since an unreadable one caches nothing and says nothing
  expect(
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas.route-thumb') as HTMLCanvasElement;
      try {
        canvas.toDataURL('image/jpeg', 0.8);
        return 'readable';
      } catch {
        return 'tainted';
      }
    }),
  ).toBe('readable');
  expect(await page.evaluate(name => caches.open(name).then(c => c.keys()).then(k => k.length), THUMB_CACHE)).toBe(4);

  // reopening asks the tile server for nothing at all
  await page.keyboard.press('Escape');
  tiles = 0;
  await openGallery();
  await expect(drawn()).toHaveCount(4);
  expect(tiles).toBe(0);
});
