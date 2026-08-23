import { test } from '@playwright/test';
import { CEILLAC, openPlanner, type TestHandles, waitForRouting } from './helpers';

test('what blocks the main thread after a reload', async ({ page }) => {
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

  await page.addInitScript(() => {
    (window as unknown as { __long: { name: string; ms: number; at: number }[] }).__long = [];
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        (window as unknown as { __long: { name: string; ms: number; at: number }[] }).__long.push({
          name: entry.name,
          ms: Math.round(entry.duration),
          at: Math.round(entry.startTime),
        });
      }
    }).observe({ entryTypes: ['longtask'] });
  });
  await page.reload();
  await page.waitForFunction(() => '__planner' in window);
  // where is the button, and is anything sitting on top of it?
  const timeline: string[] = [];
  for (let i = 0; i < 12; i++) {
    timeline.push(
      await page.evaluate(() => {
        const button = [...document.querySelectorAll('.topbar button')].find(b =>
          /routes|itinéraires/i.test(b.textContent ?? ''),
        ) as HTMLButtonElement | undefined;
        if (!button) return 'absent';
        const box = button.getBoundingClientRect();
        const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return `${Math.round(performance.now())}ms box=${Math.round(box.x)},${Math.round(box.y)} disabled=${button.disabled} top=${at?.className || at?.tagName}`;
      }),
    );
    await page.waitForTimeout(400);
  }
  console.log('BUTTON', JSON.stringify(timeline, null, 0));
  const long = await page.evaluate(() => (window as unknown as { __long: unknown[] }).__long);
  console.log('LONGTASKS', JSON.stringify(long));
  const resources = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter(r => r.duration > 300)
      .map(r => ({ url: r.name.slice(0, 90), ms: Math.round(r.duration) }))
      .slice(0, 12),
  );
  console.log('SLOW RESOURCES', JSON.stringify(resources));
});
