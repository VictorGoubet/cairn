// the sizes and limits a season of real use reaches: giant imports, a full localStorage
import { expect, test } from '@playwright/test';
import { openPlanner, type TestHandles } from './helpers';

const IGNORE = /tile|429|406|50[0-9]|AJAXError|data\.geopf\.fr|Failed to load resource|WebGL|GPU stall|ReadPixels|geolocation/i;

/** ~180 km GR-sized track, 4000 points with relief */
function bigGpx(): string {
  const pts = Array.from({ length: 4000 }, (_, i) => {
    const t = i / 3999;
    const lon = (6.3 + t * 1.4 + Math.sin(i / 40) * 0.01).toFixed(6);
    const lat = (44.5 + Math.sin(t * 6) * 0.25 + Math.cos(i / 55) * 0.008).toFixed(6);
    const ele = Math.round(1200 + Math.sin(i / 90) * 800 + Math.sin(i / 13) * 60);
    return `<trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele></trkpt>`;
  }).join('');
  return `<?xml version="1.0"?><gpx version="1.1"><trk><name>GR géant</name><trkseg>${pts}</trkseg></trk></gpx>`;
}

test('a 180 km import stays fluid and honest', async ({ page }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('console', m => {
    if (m.type() === 'error' && !IGNORE.test(m.text())) errors.push(m.text().slice(0, 200));
  });
  page.on('pageerror', e => errors.push(e.message.slice(0, 200)));
  await openPlanner(page);

  const t0 = Date.now();
  await page.locator('.topbar input[type="file"]').setInputFiles({
    name: 'gr-geant.gpx',
    mimeType: 'application/gpx+xml',
    buffer: Buffer.from(bigGpx()),
  });
  await page.waitForFunction(() => (window as unknown as TestHandles).__planner.getState().anchors.length > 2, null, {
    timeout: 60_000,
  });
  console.log('[import ms]', Date.now() - t0);

  const state = await page.evaluate(() => {
    const s = (window as unknown as TestHandles).__planner.getState();
    return {
      anchors: s.anchors.length,
      coords: s.legs.reduce((total, l) => total + (l.leg?.coords.length ?? 0), 0),
      distanceKm: Math.round(s.legs.reduce((total, l) => total + (l.leg?.distanceM ?? 0), 0) / 1000),
    };
  });
  console.log('[state]', JSON.stringify(state));
  expect(state.distanceKm).toBeGreaterThan(100);

  // the whole ui must stay alive: stats, chart, a zoom on the profile, the stages date
  await expect(page.locator('.stats-row')).toContainText('km');
  const chart = await page.locator('.chart-area svg').first().boundingBox();
  if (chart) {
    const t1 = Date.now();
    await page.mouse.move(chart.x + chart.width / 2, chart.y + chart.height / 2);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(100);
    console.log('[chart zoom ms]', Date.now() - t1);
  }

  // saving a giant route: either it fits, or the storage error says so out loud
  const t2 = Date.now();
  await page.evaluate(() => (window as unknown as TestHandles).__planner.getState().saveCurrentRoute('GR géant'));
  await page.waitForTimeout(600);
  console.log('[save ms]', Date.now() - t2);
  const outcome = await page.evaluate(() => {
    const s = (window as unknown as TestHandles).__planner.getState() as unknown as Record<string, unknown>;
    return { saved: (s.savedRoutes as unknown[]).length, error: s.error };
  });
  console.log('[save outcome]', JSON.stringify(outcome));
  expect(outcome.saved === 1 || outcome.error === 'err_storage').toBe(true);

  expect(errors, errors.join('\n')).toEqual([]);
});

test('a storage stuffed with routes fails loudly, never silently', async ({ page }) => {
  // a deterministic full disk: the routes key refuses to write, whatever the browser's quota
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key === 'cairn.routes.v1') throw new DOMException('quota', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await openPlanner(page);
  await page.evaluate(() => {
    const w = window as unknown as TestHandles;
    w.__planner.setState({ manualMode: true });
    const s = w.__planner.getState();
    s.addAnchor([6.7752, 44.6318]);
    s.addAnchor([6.78, 44.633]);
  });
  await page.waitForFunction(() => {
    const s = (window as unknown as TestHandles).__planner.getState();
    return s.legs.length === 1 && (s.legs[0].leg?.coords.length ?? 0) > 1;
  });
  await page.evaluate(() => (window as unknown as TestHandles).__planner.getState().saveCurrentRoute('plein'));
  const toast = page.locator('.toast');
  await expect(toast).toBeVisible({ timeout: 5_000 });
  await expect(toast).toContainText(/Stockage|storage/i);
});
