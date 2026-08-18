// screens the flows are never tested on by hand: tiny, sideways, tablet
import { expect, test } from '@playwright/test';
import { CEILLAC, openPlanner, type TestHandles } from './helpers';

const SIZES: [string, number, number][] = [
  ['tiny phone', 320, 568],
  ['landscape phone', 780, 360],
  ['tablet', 820, 1180],
];

for (const [name, width, height] of SIZES) {
  test(`no horizontal overflow and reachable controls on ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message.slice(0, 150)));
    await openPlanner(page);

    // two points so the stats bar and sheet have content
    await page.evaluate(center => {
      const s = (window as unknown as TestHandles).__planner;
      s.getState().addAnchor(center);
      s.getState().addAnchor([center[0] + 0.01, center[1]]);
    }, CEILLAC);
    await page.waitForTimeout(2500);

    const audit = await page.evaluate(() => {
      const docOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const offenders: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('body *')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > window.innerWidth + 2 || r.left < -2) && !el.closest('.maplibregl-map')) {
          offenders.push(`${el.className}`.slice(0, 60));
        }
      }
      return { docOverflow, offenders: [...new Set(offenders)].slice(0, 8) };
    });
    console.log(name, JSON.stringify(audit));
    expect(audit.docOverflow, `document overflows by ${audit.docOverflow}px: ${audit.offenders.join(' | ')}`).toBeLessThanOrEqual(0);
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

test('every control stays reachable on a landscape phone, scrolling if it must', async ({ page }) => {
  await page.setViewportSize({ width: 780, height: 360 });
  await openPlanner(page);
  const audit = await page.evaluate(() => {
    const column = document.querySelector<HTMLElement>('.map-controls');
    if (!column) return { unreachable: ['no column'] };
    column.scrollTop = column.scrollHeight;
    const unreachable: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('.map-controls .mc-btn, .maplibregl-ctrl button')) {
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      if (r.bottom > window.innerHeight + 1 || r.top < -1) {
        unreachable.push(el.getAttribute('aria-label') ?? el.className.slice(0, 20));
      }
    }
    return { unreachable };
  });
  expect(audit.unreachable, audit.unreachable.join(', ')).toEqual([]);
});
