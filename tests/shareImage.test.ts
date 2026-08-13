import { describe, expect, it } from 'vitest';
import type { LonLatEle } from '../src/lib/geo';
import { fitView, mercator } from '../src/lib/shareImage';

const CEILLAC_LOOP: LonLatEle[] = [
  [6.7452, 44.6158, 1900],
  [6.7752, 44.6318, 2100],
  [6.8052, 44.6528, 2400],
  [6.7852, 44.6418, 2200],
];

describe('mercator', () => {
  it('maps the origin to the middle of the world square', () => {
    expect(mercator(0, 0)).toEqual([0.5, 0.5]);
  });

  it('clamps polar latitudes instead of diverging', () => {
    const [, y] = mercator(0, 89.9);
    expect(Number.isFinite(y)).toBe(true);
    expect(y).toBeGreaterThanOrEqual(0);
  });
});

describe('fitView', () => {
  it('frames every route point inside the box with padding', () => {
    const view = fitView(CEILLAC_LOOP, 1080, 1080);
    for (const [lon, lat] of CEILLAC_LOOP) {
      const [x, y] = mercator(lon, lat);
      const px = (x - view.originX) * view.scale;
      const py = (y - view.originY) * view.scale;
      expect(px).toBeGreaterThan(1080 * 0.1);
      expect(px).toBeLessThan(1080 * 0.9);
      expect(py).toBeGreaterThan(1080 * 0.1);
      expect(py).toBeLessThan(1080 * 0.9);
    }
  });

  it('derives a walkable tile zoom for a day hike', () => {
    const view = fitView(CEILLAC_LOOP, 1080, 1080);
    expect(view.zoom).toBeGreaterThanOrEqual(10);
    expect(view.zoom).toBeLessThanOrEqual(16);
  });
});
