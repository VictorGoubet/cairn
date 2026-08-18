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

  // let the shell land in the cache, then pull the plug
  await page.waitForTimeout(1000);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#root > *').first()).toBeVisible({ timeout: 15_000 });
  await context.setOffline(false);
});
