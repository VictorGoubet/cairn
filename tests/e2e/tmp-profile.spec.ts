import { test } from '@playwright/test';
import { CEILLAC, openPlanner, type TestHandles, waitForRouting } from './helpers';

test('profile the boot block', async ({ page }) => {
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

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  await page.reload();
  await page.waitForFunction(() => '__planner' in window);
  await page.waitForTimeout(5000);
  const { profile } = (await cdp.send('Profiler.stop')) as {
    profile: {
      nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }[];
      samples: number[];
      timeDeltas: number[];
    };
  };
  const self = new Map<number, number>();
  for (let i = 0; i < profile.samples.length; i++) {
    self.set(profile.samples[i], (self.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0));
  }
  const byNode = new Map(profile.nodes.map(n => [n.id, n]));
  const top = [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([id, us]) => {
      const node = byNode.get(id);
      const frame = node?.callFrame;
      const file = (frame?.url ?? '').split('/').slice(-1)[0];
      return `${Math.round(us / 1000)} ms  ${frame?.functionName || '(anonymous)'}  ${file}:${(frame?.lineNumber ?? 0) + 1}`;
    });
  console.log(`TOP\n${top.join('\n')}`);
});
