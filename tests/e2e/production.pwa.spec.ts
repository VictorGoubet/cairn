// the offline promise, checked on the built site: the worker registers, and with the network
// gone the shell still opens
import { expect, test } from '@playwright/test';

test('production installs a service worker and survives offline', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.locator('.maplibregl-canvas')).toBeVisible();

  const registered = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { scope: reg.scope, active: reg.active?.state };
  });
  expect(registered.active).toBe('activated');

  // the manifest is what makes the browser offer "install"
  const manifest = await page.evaluate(() =>
    fetch('/manifest.webmanifest').then(res => (res.ok ? res.json() : null)),
  );
  expect(manifest?.display).toBe('standalone');
  expect(manifest?.icons?.length).toBeGreaterThanOrEqual(2);

  // a route drawn while there is still a network, so the offline half tests the panels and not
  // the router; the draft survives the reload on its own. the map needs a moment before it takes
  // clicks at all, and a click it drops is a point that never exists
  await page.waitForTimeout(2500);
  await page.locator('.segmented button', { hasText: /Manuel|Manual/ }).click();
  await page.locator('.maplibregl-canvas').click({ position: { x: 300, y: 260 } });
  await page.waitForTimeout(500);
  await page.locator('.maplibregl-canvas').click({ position: { x: 420, y: 320 } });
  await expect(page.locator('button', { hasText: /Partager|Share/ })).toBeEnabled();

  // let the shell land in the cache, then pull the plug
  await page.waitForTimeout(2000);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#root > *').first()).toBeVisible({ timeout: 15_000 });

  // the rarely used panels are their own chunks, absent from the html the worker precaches: they
  // are warmed after first paint on purpose, and a dead zone must not be where that shows
  await page.locator('button', { hasText: /Partager|Share/ }).click();
  await page.locator('button', { hasText: /QR/ }).click();
  await expect(page.locator('.qr-panel')).toBeVisible({ timeout: 15_000 });
  await context.setOffline(false);
});
