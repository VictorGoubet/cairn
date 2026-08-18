// what localStorage holds may have been hand-edited or half-written: the app must boot anyway
import { expect, test } from '@playwright/test';

const HOSTILE: [string, string][] = [
  ['garbage json', '{{{{'],
  ['wrong shapes', '{"anchors":"lol","legs":42,"offRoutePoints":{"a":1},"currentRouteName":[]}'],
  ['null members', '{"anchors":[null],"legs":[null]}'],
  ['anchor missing fields', '{"anchors":[{"id":"x"}],"legs":[{"id":"y"}]}'],
  ['legs without coords', '{"anchors":[{"id":"a","lon":6.5,"lat":44.6,"kind":"checkpoint","name":""},{"id":"b","lon":6.51,"lat":44.6,"kind":"checkpoint","name":""}],"legs":[{"id":"l","manual":false,"leg":{"distanceM":"NaN"}}]}'],
];

for (const [name, draft] of HOSTILE) {
  test(`survives a hostile draft: ${name}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message.slice(0, 200)));
    await page.addInitScript(value => {
      localStorage.setItem('cairn.draft.v1', value);
      localStorage.setItem('rando-planner-draft', value);
      localStorage.setItem('cairn-draft', value);
    }, draft);
    await page.goto('/');
    await expect(page.locator('.maplibregl-canvas')).toBeVisible({ timeout: 20_000 });
    await page.waitForFunction(() => '__planner' in window);
    expect(errors, errors.join('\n')).toEqual([]);
  });
}
