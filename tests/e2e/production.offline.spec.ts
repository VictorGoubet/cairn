// the offline promise where it is real: the built site, its service worker, and no network
import { expect, test } from '@playwright/test';

test('a downloaded area serves its maps and its fountains with the network cut', async ({ page, context }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await expect(page.locator('.maplibregl-canvas')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(async () => {
    const reg = await navigator.serviceWorker.ready;
    return reg.active?.state === 'activated';
  });

  // frame the bois de Vincennes through the UI: production strips the test handles
  await page.locator('.search-box input').fill('48.833, 2.435');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);

  // the fountains overlay on, so the live app requests the very cells the bundle will hold
  await page.locator('[data-control="options"]').click();
  await page
    .locator('.option-row', { hasText: /Refuges & points d'eau|Huts & water points/ })
    .locator('input[type="checkbox"]')
    .check();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(4000);

  // download the framed area under our own name
  await page.locator('.topbar button', { hasText: /itinéraires|routes/i }).click();
  const download = page.locator('[data-control="area-download"]');
  await expect(download).toBeEnabled();
  await download.click();
  await page.locator('.area-name-row input').fill('Bois de Vincennes');
  await page.locator('[data-control="area-confirm"]').click();
  await expect(page.locator('.area-list li', { hasText: 'Bois de Vincennes' })).toBeVisible({ timeout: 120_000 });
  await page.keyboard.press('Escape');

  // cut the network: from here only the service worker can answer
  const servedOffline: string[] = [];
  page.on('response', res => {
    if (res.fromServiceWorker() && /drinking_water|PLAN\.IGN|SCAN25/.test(res.url())) servedOffline.push(res.url());
  });
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('.maplibregl-canvas')).toBeVisible({ timeout: 20_000 });

  await page.locator('.search-box input').fill('48.833, 2.435');
  await page.keyboard.press('Enter');
  await page.locator('[data-control="options"]').click();
  await page
    .locator('.option-row', { hasText: /Refuges & points d'eau|Huts & water points/ })
    .locator('input[type="checkbox"]')
    .check();
  await page.keyboard.press('Escape');

  // the map draws and the fountain cells answer, both out of the bundle
  await expect.poll(() => servedOffline.some(u => /PLAN\.IGN|SCAN25/.test(u)), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => servedOffline.some(u => u.includes('drinking_water')), { timeout: 30_000 }).toBe(true);
  // and the area survived the reload with the name we gave it
  await page.locator('.topbar button', { hasText: /itinéraires|routes/i }).click();
  await expect(page.locator('.area-list li', { hasText: 'Bois de Vincennes' })).toBeVisible();

  await context.setOffline(false);
});
