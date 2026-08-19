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
  it('bundles the chrome, all four French maps, the pois and the active foreign base', () => {
    const urls = corridorUrls(ROUTE, 'swisstopo');
    expect(urls.some(u => u.includes('standard.json'))).toBe(true);
    expect(urls.some(u => u.includes('/fonts/'))).toBe(true);
    expect(urls.some(u => u.includes('PLAN.IGN/14/'))).toBe(true);
    expect(urls.some(u => u.includes('SCAN25TOUR') && u.includes('TILEMATRIX=15'))).toBe(true);
    expect(urls.some(u => u.includes('ORTHOIMAGERY'))).toBe(true);
    expect(urls.some(u => u.includes('tile.openstreetmap.org'))).toBe(true);
    expect(urls.some(u => u.includes('wmts.geo.admin.ch'))).toBe(true);
    // a base nobody is looking at stays out
    expect(urls.some(u => u.includes('opentopomap'))).toBe(false);
    expect(urls.some(u => u.includes('refuges.info/api/bbox'))).toBe(true);
    expect(urls.some(u => u.includes('overpass-api.de/api/interpreter?data='))).toBe(true);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('keeps a full GR-sized trek under the download cap', () => {
    // ~160 km with the same density a router produces
    const gr: LonLatEle[] = Array.from({ length: 2000 }, (_, i) => [6.3 + i * 0.0008, 44.5 + i * 0.0003, 1500]);
    const urls = corridorUrls(gr);
    console.log(`gr bundle: ${urls.length} resources`);
    expect(urls.length).toBeLessThan(12_000);
    // and a day hike stays a light download
    expect(corridorUrls(ROUTE).length).toBeLessThan(1200);
  });
});
