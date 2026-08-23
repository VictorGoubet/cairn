import { describe, expect, it } from 'vitest';
import type { LonLatEle } from '../../src/lib/geo';
import { DEFAULT_PROFILE } from '../../src/lib/hikingTime';
import { buildRoadbook } from '../../src/lib/roadbook';
import { byCollection, collectionSiblings, type Anchor, type LegSlot, type SavedRoute } from '../../src/store';

/** a leg of `steps` segments of 100 horizontal metres, climbing `risePerStep` each */
function leg(steps: number, risePerStep: number, fromLat: number, fromEle: number): LegSlot {
  const degPerM = 1 / 111_320;
  const coords: LonLatEle[] = Array.from({ length: steps + 1 }, (_, i) => [
    6.7,
    fromLat + i * 100 * degPerM,
    fromEle + i * risePerStep,
  ]);
  return { id: `l${fromLat}`, manual: true, leg: { coords, distanceM: steps * 100 } } as LegSlot;
}

function anchor(name: string, kind: Anchor['kind']): Anchor {
  return { id: `a-${name}-${kind}`, lon: 6.7, lat: 44.6, kind, name };
}

describe('buildRoadbook', () => {
  // 2 km climbing 200 m, then 2 km back down: a water point in the middle, a plain checkpoint after
  const ANCHORS = [
    anchor('Vallon', 'checkpoint'),
    anchor('Source', 'water'),
    anchor('', 'checkpoint'),
    anchor('Col', 'summit'),
  ];
  const LEGS = [leg(20, 10, 44.6, 1500), leg(10, 10, 44.62, 1700), leg(10, -10, 44.63, 1800)];

  it('keeps the landmarks and drops the plain geometry', () => {
    const book = buildRoadbook(ANCHORS, LEGS, DEFAULT_PROFILE);
    // the unnamed checkpoint in the middle is not a landmark; the ends always are
    expect(book.rows.map(r => r.name)).toEqual(['Vallon', 'Source', 'Col']);
    expect(book.rows.map(r => r.role)).toEqual(['start', 'point', 'finish']);
  });

  it('counts distance, climb and altitude from the start', () => {
    const book = buildRoadbook(ANCHORS, LEGS, DEFAULT_PROFILE);
    const [start, water, col] = book.rows;
    expect(start.distanceM).toBe(0);
    expect(start.elevation).toBeCloseTo(1500, 0);
    expect(water.distanceM).toBe(2000);
    expect(water.gainM).toBeCloseTo(200, 0);
    expect(water.elevation).toBeCloseTo(1700, 0);
    // the last row carries the whole route, and the summary agrees with it
    expect(col.distanceM).toBe(4000);
    expect(col.gainM).toBeCloseTo(300, 0);
    expect(book.distanceM).toBe(4000);
    expect(book.lossM).toBeCloseTo(100, 0);
  });

  it('measures the split against the previous row, skipped points included', () => {
    const book = buildRoadbook(ANCHORS, LEGS, DEFAULT_PROFILE);
    // the last leg is 1 km, but the row before it is 2 km back: the split spans the dropped point
    expect(book.rows[2].legDistanceM).toBe(2000);
    expect(book.rows[0].legDistanceM).toBe(0);
    expect(book.rows.reduce((sum, r) => sum + r.legDistanceM, 0)).toBe(book.distanceM);
  });

  it('turns the estimate into clock times, or leaves the column empty', () => {
    const at8 = new Date('2026-08-24T08:00:00');
    const book = buildRoadbook(ANCHORS, LEGS, DEFAULT_PROFILE, at8);
    expect(book.rows[0].at?.getTime()).toBe(at8.getTime());
    const arrival = book.rows[2].at as Date;
    expect(arrival.getTime() - at8.getTime()).toBeCloseTo(book.hours * 3_600_000, -3);
    expect(buildRoadbook(ANCHORS, LEGS, DEFAULT_PROFILE).rows[0].at).toBeNull();
  });

  it('gets a runner to the finish before a hiker, and says nothing about an empty route', () => {
    const running = buildRoadbook(ANCHORS, LEGS, { ...DEFAULT_PROFILE, mode: 'run', packKg: 2 });
    expect(running.hours).toBeLessThan(buildRoadbook(ANCHORS, LEGS, DEFAULT_PROFILE).hours);
    expect(buildRoadbook([], [], DEFAULT_PROFILE).rows).toEqual([]);
  });

  it('survives a leg that has not finished routing', () => {
    const pending = [LEGS[0], { id: 'x', manual: false, leg: null } as LegSlot, LEGS[2]];
    const book = buildRoadbook(ANCHORS, pending, DEFAULT_PROFILE);
    expect(book.rows).toHaveLength(3);
    expect(book.distanceM).toBe(3000);
  });
});

describe('collections', () => {
  const race = (id: string, name: string, collection?: string): SavedRoute => ({
    id,
    name,
    collection,
    updatedAt: '2026-08-23T08:00:00.000Z',
    distanceM: 1000,
    gainM: 100,
    anchors: [],
    legs: [],
    offRoutePoints: [],
  });
  const ROUTES = [
    race('a', '62 km', 'Crêtes 2027'),
    race('b', '42 km', 'Crêtes 2027'),
    race('c', 'Queyras'),
    race('d', '21 km', 'Crêtes 2027'),
  ];

  it('groups the courses of a project together and leaves the loose ones last', () => {
    expect(byCollection(ROUTES).map(g => [g.name, g.routes.length])).toEqual([
      ['Crêtes 2027', 3],
      ['', 1],
    ]);
  });

  it('shows the open course its siblings, and nothing to a route in no project', () => {
    const siblings = collectionSiblings({ savedRoutes: ROUTES, currentRouteId: 'a' });
    expect(siblings.map(r => r.id)).toEqual(['b', 'd']);
    expect(collectionSiblings({ savedRoutes: ROUTES, currentRouteId: 'c' })).toEqual([]);
    // the same array every time, filled or empty: a fresh one re-renders the map for ever
    expect(collectionSiblings({ savedRoutes: ROUTES, currentRouteId: null })).toBe(
      collectionSiblings({ savedRoutes: ROUTES, currentRouteId: 'c' }),
    );
    expect(collectionSiblings({ savedRoutes: ROUTES, currentRouteId: 'a' })).toBe(siblings);
  });
});
