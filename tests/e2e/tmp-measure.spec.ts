import { test } from '@playwright/test';
import { CEILLAC, openPlanner, type TestHandles, waitForRouting } from './helpers';

test('thumbnails survive a reload', async ({ page }) => {
  await openPlanner(page);
  await page.evaluate(() => {
    (window as unknown as TestHandles).__planner.setState({ manualMode: true });
  });
  for (let i = 0; i < 5; i++) {
    await page.evaluate(
      ({ center, index }) => {
        const s = (window as unknown as TestHandles).__planner.getState();
        s.clear();
        s.addAnchor([center[0] - index * 0.9, center[1] - index * 0.35]);
        s.addAnchor([center[0] - index * 0.9 + 0.05, center[1] - index * 0.35 + 0.03]);
      },
      { center: CEILLAC, index: i },
    );
    await waitForRouting(page, 1);
    await page.evaluate(i => {
      (window as unknown as TestHandles).__planner.getState().saveCurrentRoute(`route ${i}`);
    }, i);
  }

  let tiles = 0;
  page.on('request', r => {
    if (r.url().includes('geopf.fr/wmts')) tiles++;
  });
  const open = async () => {
    await page.locator('.topbar button', { hasText: /itinéraires|routes/i }).click();
    await page.locator('canvas.route-thumb:not(.loading)').nth(4).waitFor({ timeout: 30_000 });
  };

  const t0 = Date.now();
  await open();
  console.log(`FIRST: ${Date.now() - t0} ms, ${tiles} tiles`);

  await page.addInitScript(() => {
    (window as unknown as { __long: number[][] }).__long = [];
    new PerformanceObserver(list => {
      for (const e of list.getEntries())
        (window as unknown as { __long: number[][] }).__long.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ entryTypes: ['longtask'] });
  });
  const r0 = Date.now();
  await page.reload();
  await page.waitForFunction(() => '__planner' in window);
  const booted = Date.now();
  tiles = 0;
  // dispatched from inside the page: what a finger does, without playwright's actionability waits
  const inPage = await page.evaluate(async () => {
    const button = [...document.querySelectorAll('.topbar button')].find(b =>
      /routes|itinéraires/i.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    const t0 = performance.now();
    button.click();
    const painted = await new Promise<number>(resolve => {
      const tick = () => {
        if (document.querySelector('canvas.route-thumb:not(.loading)')) resolve(performance.now() - t0);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return Math.round(painted);
  });
  console.log(`RELOAD boot ${booted - r0} ms | click to first thumb ${inPage} ms | ${tiles} tiles`);
  console.log('LONG', JSON.stringify(await page.evaluate(() => (window as unknown as { __long: number[][] }).__long)));
});
