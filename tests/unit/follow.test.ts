import { describe, expect, it } from 'vitest';
import { locate } from '../../src/lib/follow';
import { cumulativeDistancesM, type LonLatEle } from '../../src/lib/geo';

// a straight climb east: ~790 m per 0.01 degree of longitude at this latitude
const ROUTE: LonLatEle[] = Array.from({ length: 21 }, (_, i) => [6.7 + i * 0.002, 44.6, 1500 + i * 20]);
const DISTS = cumulativeDistancesM(ROUTE);
const POIS = [
  { name: 'Refuge', distM: DISTS[10] },
  { name: 'Sommet', distM: DISTS[20] },
];

describe('locate', () => {
  it('projects a position onto the route and counts what is left', () => {
    const fix = locate(ROUTE, DISTS, POIS, [ROUTE[5][0], 44.6], 8);
    expect(fix.offRouteM).toBeLessThan(1);
    expect(fix.travelledM).toBeCloseTo(DISTS[5], 0);
    expect(fix.remainingM).toBeCloseTo(DISTS[20] - DISTS[5], 0);
    // 15 segments of 20 m still to climb
    expect(fix.remainingGainM).toBeCloseTo(300, 0);
    expect(fix.remainingHours).toBeGreaterThan(0);
  });

  it('names the next point ahead, with the climb to reach it', () => {
    const fix = locate(ROUTE, DISTS, POIS, [ROUTE[3][0], 44.6], 5);
    expect(fix.next?.name).toBe('Refuge');
    expect(fix.next?.distanceM).toBeCloseTo(DISTS[10] - DISTS[3], 0);
    expect(fix.next?.gainM).toBeCloseTo(140, 0);
  });

  it('moves on to the following point once one is passed', () => {
    const fix = locate(ROUTE, DISTS, POIS, [ROUTE[12][0], 44.6], 5);
    expect(fix.next?.name).toBe('Sommet');
  });

  it('reports the distance to the trace when walking beside it', () => {
    // ~110 m north of the route
    const fix = locate(ROUTE, DISTS, POIS, [ROUTE[5][0], 44.601], 5);
    expect(fix.offRouteM).toBeGreaterThan(90);
    expect(fix.offRouteM).toBeLessThan(130);
    // the projection still works: being off the trail does not lose the progress
    expect(fix.travelledM).toBeCloseTo(DISTS[5], -1);
  });

  it('has no next point once the finish is the only thing left', () => {
    expect(locate(ROUTE, DISTS, POIS, [ROUTE[20][0], 44.6], 5).next).toBeNull();
  });
});
