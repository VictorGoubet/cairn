import { describe, expect, it } from 'vitest';
import type { LonLatEle } from '../../src/lib/geo';
import { corridorTiles, corridorUrls } from '../../src/lib/offline';

/** ~11 km along the Queyras, one point per ~100 m like a routed leg */
const ROUTE: LonLatEle[] = Array.from({ length: 100 }, (_, i) => [6.6 + i * 0.001, 44.6 + i * 0.0004, 2000]);

describe('corridorTiles', () => {
  it('covers every point of the trace at every zoom, without duplicates', () => {
    for (const z of [8, 12, 14]) {
      const tiles = corridorTiles(ROUTE, z);
      expect(tiles.length).toBeGreaterThan(0);
      expect(new Set(tiles.map(([x, y]) => `${x}/${y}`)).size).toBe(tiles.length);
      const n = 2 ** z;
      for (const [lon, lat] of ROUTE) {
        const x = Math.floor(((lon + 180) / 360) * n);
        const rad = (lat * Math.PI) / 180;
        const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
        expect(tiles.some(([tx, ty]) => tx === x && ty === y), `z${z} misses ${x}/${y}`).toBe(true);
      }
    }
  });
});

describe('corridorUrls', () => {
  it('bundles the map chrome, the tiles and the poi cells of the live overlays', () => {
    const urls = corridorUrls(ROUTE);
    expect(urls.some(u => u.includes('standard.json'))).toBe(true);
    expect(urls.some(u => u.includes('/fonts/'))).toBe(true);
    expect(urls.some(u => u.includes('PLAN.IGN/14/'))).toBe(true);
    expect(urls.some(u => u.includes('refuges.info/api/bbox'))).toBe(true);
    expect(urls.some(u => u.includes('overpass-api.de/api/interpreter?data='))).toBe(true);
    // an 11 km day stays a light download
    expect(urls.length).toBeLessThan(400);
    expect(new Set(urls).size).toBe(urls.length);
  });
});
