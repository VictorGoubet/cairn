import { expect, test } from '@playwright/test';
import { CEILLAC, clickAt, openPlanner, type TestHandles, waitForRouting } from './helpers';

const FURTHER: [number, number] = [CEILLAC[0] + 0.016, CEILLAC[1] + 0.001];

// third-party hiccups (tiles, brouter busy, IGN metadata under rate limit) are not our bugs
const IGNORE =
  /tile|429|406|50[0-9]|AJAXError|data\.geopf\.fr|Failed to load resource|WebGL|GPU stall|ReadPixels|geolocation/i;

function collect(page: import('@playwright/test').Page): string[] {
  const errors: string[] = [];
  page.on('console', m => {
    if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(`console: ${JSON.stringify(m.text().slice(0, 500))}`);
  });
  page.on('pageerror', e => {
    if (!IGNORE.test(e.message)) errors.push(`pageerror: ${e.message.slice(0, 200)}`);
  });
  return errors;
}

test('desktop grand tour stays clean', async ({ page }) => {
  const errors = collect(page);
  await openPlanner(page);

  // draw, insert, undo/redo, reverse, loop
  await clickAt(page, CEILLAC);
  await clickAt(page, FURTHER);
  await waitForRouting(page, 1);
  await page.evaluate(() => {
    const s = (window as unknown as TestHandles).__planner;
    s.getState().undo();
    s.getState().redo();
  });
  await page.locator('.side button', { hasText: /Inverser|Reverse/ }).click();
  await waitForRouting(page, 1);
  await page.locator('[data-control="loop"]').click();
  await page.waitForTimeout(800);
  await page.locator('[data-control="loop"]').click();

  // profile chart: zoom, select, then clear
  const chart = page.locator('.chart-area svg').first();
  const box = await chart.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await page.mouse.wheel(0, 400);
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
  }

  // flyover start/stop, follow toggle (geolocation will be denied: expected, not an error)
  await page.locator('[data-control="flyover"]').click();
  await page.waitForTimeout(1500);
  await page.locator('[data-control="flyover-stop"]').click();

  // panels: layers, options, explore, profile fields
  for (const control of ['layers', 'options', 'explore']) {
    await page.locator(`[data-control="${control}"]`).click();
    await page.waitForTimeout(400);
  }
  await page.keyboard.press('Escape');

  // language round trip
  await page.locator('.lang-seg button', { hasText: 'EN' }).click();
  await page.locator('.lang-seg button', { hasText: 'FR' }).click();

  // share studio through every preset
  await page.locator('.topbar .menu-wrap button', { hasText: /Partager|Share/ }).click();
  await page.locator('[data-control="share-image"]').click();
  for (let i = 0; i < 5; i++) {
    await page.locator('[data-control="share-next"]').click();
    await page.waitForTimeout(600);
  }
  await page.keyboard.press('Escape');

  // reload restores the draft
  await page.reload();
  await page.waitForFunction(() => '__planner' in window);
  await page.waitForTimeout(1200);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('empty states and rapid fire stay clean', async ({ page }) => {
  const errors = collect(page);
  await openPlanner(page);

  // acting on an empty route: undo with nothing, escape storms, rapid toggles
  await page.evaluate(() => {
    const s = (window as unknown as TestHandles).__planner;
    for (let i = 0; i < 5; i++) {
      s.getState().undo();
      s.getState().redo();
    }
    s.getState().clear();
  });
  for (let i = 0; i < 6; i++) await page.keyboard.press('Escape');
  for (let i = 0; i < 4; i++) {
    await page.locator('[data-control="options"]').click();
  }
  await page.keyboard.press('Escape');

  // one point only, then delete it from its editor
  await clickAt(page, CEILLAC);
  await page.locator('.maplibregl-marker .anchor-marker').first().click();
  await page.locator('.point-editor button', { hasText: /Supprimer|Delete/ }).click();

  // click the same spot 6 times fast, then clear while legs may be routing
  for (let i = 0; i < 6; i++) {
    await clickAt(page, [CEILLAC[0] + i * 0.002, CEILLAC[1]]);
  }
  await page.evaluate(() => (window as unknown as TestHandles).__planner.getState().clear());
  await page.waitForTimeout(1500);

  expect(errors, errors.join('\n')).toEqual([]);
});
