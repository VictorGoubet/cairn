import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BivouacProbe,
  nearestDistanceM,
  RING_SAMPLES,
  scoreBivouac,
  waterMinutes,
} from '../../src/lib/bivouac';
import type { LonLatEle } from '../../src/lib/geo';

/** a probe on ground of a given slope, with a ring at a given height relative to the spot */
function probe(slopeDeg: number, ringDelta: number | number[], elevation = 2000): BivouacProbe {
  const drop = Math.tan((slopeDeg * Math.PI) / 180) * 25;
  const ring = Array.from({ length: RING_SAMPLES }, (_, i) =>
    elevation + (Array.isArray(ringDelta) ? ringDelta[i % ringDelta.length] : ringDelta),
  );
  return { elevation, cross: [elevation + drop, elevation, elevation - drop, elevation], ring };
}

const IDEAL = { waterMinutes: 3, intrusionM: 900 };

describe('scoreBivouac', () => {
  it('rates a flat sheltered spot by a spring near the top', () => {
    // flat, ringed by ground 30 m higher, water 3 minutes away, nothing man-made around
    const score = scoreBivouac(probe(1, 30), IDEAL);
    expect(score.veto).toBeNull();
    expect(score.total).toBeGreaterThan(70);
    expect(score.flatness).toBeCloseTo(1, 2);
    expect(score.water).toBeCloseTo(1, 2);
    expect(score.shelter).toBeCloseTo(1, 2);
  });

  it('refuses ground too steep to pitch on, whatever else it offers', () => {
    const score = scoreBivouac(probe(28, 30), IDEAL);
    expect(score.veto).toBe('slope');
    expect(score.total).toBe(0);
    expect(score.slopeDeg).toBeGreaterThan(25);
  });

  it('refuses a spot up against a road or a house', () => {
    const score = scoreBivouac(probe(1, 30), { waterMinutes: 2, intrusionM: 10 });
    expect(score.veto).toBe('intrusion');
    expect(score.total).toBe(0);
  });

  it('reads the slope of the ground, not of the surroundings', () => {
    expect(scoreBivouac(probe(0, 30), IDEAL).slopeDeg).toBeCloseTo(0, 3);
    expect(scoreBivouac(probe(10, 30), IDEAL).slopeDeg).toBeCloseTo(10, 1);
    // a gentle slope still costs: the tent slides
    expect(scoreBivouac(probe(10, 30), IDEAL).flatness).toBeLessThan(0.7);
  });

  it('prefers water at the camp over water half an hour away', () => {
    const near = scoreBivouac(probe(1, 30), { ...IDEAL, waterMinutes: 4 });
    const far = scoreBivouac(probe(1, 30), { ...IDEAL, waterMinutes: 28 });
    expect(near.total - far.total).toBeGreaterThan(15);
    // and no water at all is the worst of the three
    expect(scoreBivouac(probe(1, 30), { ...IDEAL, waterMinutes: null }).water).toBe(0);
  });

  it('separates a sheltered hollow from an exposed crest', () => {
    const hollow = scoreBivouac(probe(1, 30), IDEAL);
    const crest = scoreBivouac(probe(1, -140), IDEAL);
    expect(hollow.shelter).toBeGreaterThan(0.9);
    expect(crest.shelter).toBeCloseTo(0, 2);
    // the crest pays on shelter but earns on the view
    expect(crest.view).toBeGreaterThan(0.9);
    expect(hollow.view).toBeCloseTo(0, 2);
  });

  it('grants a view to a spot open on a few sides only', () => {
    // half the ring drops away, the other half rises: a shoulder, the classic good bivouac
    const shoulder = scoreBivouac(probe(1, [-150, -150, -150, -150, -150, -150, 30, 30, 30, 30, 30, 30]), IDEAL);
    expect(shoulder.view).toBeGreaterThan(0.9);
    expect(shoulder.shelter).toBeGreaterThan(0.4);
    expect(shoulder.total).toBeGreaterThan(scoreBivouac(probe(1, -150), IDEAL).total);
  });

  it('treats an empty answer around as quiet, and a close road as not', () => {
    expect(scoreBivouac(probe(1, 30), { waterMinutes: 3, intrusionM: null }).quiet).toBe(1);
    expect(scoreBivouac(probe(1, 30), { waterMinutes: 3, intrusionM: 60 }).quiet).toBeLessThan(0.3);
  });
});

describe('waterMinutes', () => {
  it('prices the walk, not the crow flight: a spring below a slope is further away', () => {
    const spot: [number, number, number] = [6.7, 44.6, 2000];
    // both 300 m away, one on the flat, one 100 m below
    const flat = waterMinutes(spot, [[6.70379, 44.6, 2000]]);
    const below = waterMinutes(spot, [[6.70379, 44.6, 1900]]);
    expect(flat).not.toBeNull();
    expect(below).toBeGreaterThan((flat as number) * 1.2);
  });

  it('keeps the closest of several, and says nothing when the list is empty', () => {
    const spot: [number, number, number] = [6.7, 44.6, 2000];
    const two = waterMinutes(spot, [
      [6.71, 44.6, 2000],
      [6.702, 44.6, 2000],
    ]);
    expect(two).toBeLessThan(waterMinutes(spot, [[6.71, 44.6, 2000]]) as number);
    expect(waterMinutes(spot, [])).toBeNull();
  });
});

describe('nearestDistanceM', () => {
  it('measures to the closest point, or nothing at all', () => {
    expect(nearestDistanceM([6.7, 44.6], [])).toBeNull();
    expect(nearestDistanceM([6.7, 44.6], [[6.705, 44.6], [6.9, 44.6]])).toBeCloseTo(396, -1);
  });
});

describe('findBivouacSpots', () => {
  // the registry is reset before each mock: the static import at the top of this file already
  // pulled the real modules in, and a dynamic import would hand back that cached copy
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../../src/lib/demElevation');
    vi.doUnmock('../../src/lib/overpass');
    vi.restoreAllMocks();
  });

  /** a 3 km route across a valley floor */
  const ROUTE: LonLatEle[] = Array.from({ length: 60 }, (_, i) => [6.7 + i * 0.0005, 44.6, 2000]);

  it('suggests spots along the route, spaced out, best first', async () => {
    // a DEM that is flat everywhere, and one spring beside the route
    vi.doMock('../../src/lib/demElevation', () => ({
      sampleElevations: async (points: [number, number][]) => points.map(() => 2000),
      DEM_TILE_SIZE: 256,
    }));
    vi.doMock('../../src/lib/overpass', () => ({
      overpassQuery: async (query: string) =>
        query.includes('spring') ? [{ lon: 6.707, lat: 44.601 }] : [],
      overpassUrl: (endpoint: string, q: string) => `${endpoint}?data=${q}`,
      OVERPASS_PRIMARY: 'https://overpass-api.de/api/interpreter',
    }));
    const { findBivouacSpots: find } = await import('../../src/lib/bivouac');

    const { spots, terrainOnly } = await find(ROUTE);
    expect(terrainOnly).toBe(false);
    expect(spots.length).toBeGreaterThan(1);
    // sorted, spaced, and each one honest about why it scored
    for (let i = 1; i < spots.length; i++) expect(spots[i - 1].total).toBeGreaterThanOrEqual(spots[i].total);
    for (const spot of spots) {
      expect(spot.veto).toBeNull();
      expect(spot.total).toBeGreaterThanOrEqual(45);
      expect(spot.waterMinutes).not.toBeNull();
    }
    const [first, second] = spots;
    if (second) {
      const gap = Math.hypot((first.point[0] - second.point[0]) * 79_000, (first.point[1] - second.point[1]) * 111_000);
      expect(gap).toBeGreaterThan(300);
    }
  });

  it('says so when the map data cannot be reached, instead of claiming there is no water', async () => {
    vi.doMock('../../src/lib/demElevation', () => ({
      sampleElevations: async (points: [number, number][]) => points.map(() => 2000),
      DEM_TILE_SIZE: 256,
    }));
    vi.doMock('../../src/lib/overpass', () => ({
      overpassQuery: async () => {
        throw new Error('overpass refused');
      },
      overpassUrl: (endpoint: string, q: string) => `${endpoint}?data=${q}`,
      OVERPASS_PRIMARY: 'https://overpass-api.de/api/interpreter',
    }));
    const { findBivouacSpots: find } = await import('../../src/lib/bivouac');

    const { spots, terrainOnly } = await find(ROUTE);
    expect(terrainOnly).toBe(true);
    for (const spot of spots) expect(spot.waterMinutes).toBeNull();
  });

  it('finds nothing on a route with no room for a tent', async () => {
    // every candidate on a 30 degree slope
    vi.doMock('../../src/lib/demElevation', () => ({
      sampleElevations: async (points: [number, number][]) => points.map(p => 2000 + p[1] * 60_000),
      DEM_TILE_SIZE: 256,
    }));
    vi.doMock('../../src/lib/overpass', () => ({
      overpassQuery: async () => [],
      overpassUrl: (endpoint: string, q: string) => `${endpoint}?data=${q}`,
      OVERPASS_PRIMARY: 'https://overpass-api.de/api/interpreter',
    }));
    const { findBivouacSpots: find } = await import('../../src/lib/bivouac');
    expect((await find(ROUTE)).spots).toEqual([]);
  });
});
