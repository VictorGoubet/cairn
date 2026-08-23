import { test } from '@playwright/test';
import { CEILLAC, type TestHandles } from './helpers';

test('what the boot spends its time on', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => '__map' in window && '__planner' in window);
  await page.evaluate(center => {
    (window as unknown as TestHandles).__map.jumpTo({ center, zoom: 14 });
  }, CEILLAC);
  await page.waitForTimeout(6000);

  const report = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const byHost = new Map<string, { n: number; kb: number; ms: number }>();
    for (const r of res) {
      const host = new URL(r.name).host;
      const cur = byHost.get(host) ?? { n: 0, kb: 0, ms: 0 };
      cur.n++;
      cur.kb += Math.round((r.encodedBodySize || r.transferSize || 0) / 1024);
      cur.ms = Math.max(cur.ms, Math.round(r.responseEnd));
      byHost.set(host, cur);
    }
    const biggest = [...res]
      .sort((a, b) => (b.encodedBodySize || 0) - (a.encodedBodySize || 0))
      .slice(0, 8)
      .map(r => `${Math.round((r.encodedBodySize || 0) / 1024)} kB ${Math.round(r.duration)} ms ${r.name.split('/').slice(-1)[0].slice(0, 60)}`);
    const paint = performance.getEntriesByType('paint').map(p => `${p.name} ${Math.round(p.startTime)}`);
    return {
      dcl: Math.round(nav.domContentLoadedEventEnd),
      load: Math.round(nav.loadEventEnd),
      paint,
      hosts: [...byHost.entries()].map(([h, v]) => `${h}: ${v.n} req, ${v.kb} kB, last at ${v.ms} ms`),
      biggest,
      total: res.length,
    };
  });
  console.log(`BOOT ${JSON.stringify(report, null, 1)}`);
});
