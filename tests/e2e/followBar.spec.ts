import { expect, test } from '@playwright/test';
import { CEILLAC, openPlanner, type TestHandles, waitForRouting } from './helpers';

test.use({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
  geolocation: { longitude: CEILLAC[0] + 0.002, latitude: CEILLAC[1] + 0.0005 },
  permissions: ['geolocation'],
});

test('the follow bar prices every stretch up and down, readable on a phone', async ({ page }) => {
  await openPlanner(page);
  await page.evaluate(center => {
    const s = (window as unknown as TestHandles).__planner;
    s.setState({ manualMode: true });
    s.getState().addAnchor(center);
    s.getState().addAnchor([center[0] + 0.005, center[1] + 0.001]);
    s.getState().addAnchor([center[0] + 0.002, center[1] + 0.005]);
  }, CEILLAC);
  await waitForRouting(page, 2);
  // the middle anchor becomes a named camp
  await page.locator('.maplibregl-marker .anchor-marker').first().tap();
  await page.locator('.kind-option', { hasText: /Bivouac|Camp/ }).tap();
  await page.locator('.point-name').fill('Bivouac du lac');
  await page.keyboard.press('Escape');

  await page.locator('[data-control="follow"]').tap();
  await expect(page.locator('.follow-bar .follow-value').first()).toBeVisible({ timeout: 20_000 });
  // the live position also lands on the elevation chart: open the sheet and look for the dot
  await page.locator('.sheet-grip').tap();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const dot = document.querySelector<SVGGElement>('.viz-flyover-dot');
          return dot ? dot.style.display !== 'none' : false;
        }),
      { timeout: 10_000 },
    )
    .toBe(true);
  await page.screenshot({
    path: '/private/tmp/claude-502/-Users-victor-goubet-Documents-code-hai/20284d64-0627-46bd-b74c-e5464e104b6a/scratchpad/follow-chart.png',
  });
  await page.locator('.sheet-grip').tap();
  await page.locator('.sheet-grip').tap();

  const texts = await page.locator('.follow-value').allTextContents();
  // every row prices its stretch in climb AND descent, and tonight's camp is not repeated as
  // "next point" when it is the very next point
  expect(texts).toHaveLength(2);
  for (const row of texts) expect(row).toMatch(/\+\d+ \/ -\d+ m/);
  expect(texts[0]).toContain('Bivouac du lac');
});
