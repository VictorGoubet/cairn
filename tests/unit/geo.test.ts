import { describe, expect, it } from 'vitest';
import {
  cumulativeDistancesM,
  elevationStats,
  formatDistance,
  formatDuration,
  haversineM,
  kmMarkerPoints,
  type LonLatEle,
  nearestIndex,
  pathDistanceM,
  pointToPathDistanceM,
  simplifyIndices,
} from '../../src/lib/geo';

describe('haversineM', () => {
  it('measures a known distance', () => {
    // Paris Notre-Dame to Lyon Bellecour, about 392 km
    const distance = haversineM([2.3499, 48.853], [4.8324, 45.7578]);
    expect(distance).toBeGreaterThan(390_000);
    expect(distance).toBeLessThan(394_000);
  });

  it('is zero for identical points and symmetric', () => {
    expect(haversineM([6.5, 44.6], [6.5, 44.6])).toBe(0);
    expect(haversineM([6.5, 44.6], [6.6, 44.7])).toBeCloseTo(haversineM([6.6, 44.7], [6.5, 44.6]), 6);
  });
});

describe('cumulativeDistancesM', () => {
  it('starts at zero and grows monotonically', () => {
    const coords: LonLatEle[] = [
      [6.5, 44.6, 1000],
      [6.51, 44.6, 1010],
      [6.52, 44.6, 1020],
    ];
    const dists = cumulativeDistancesM(coords);
    expect(dists).toHaveLength(3);
    expect(dists[0]).toBe(0);
    expect(dists[1]).toBeGreaterThan(0);
    expect(dists[2]).toBeGreaterThan(dists[1]);
    expect(dists[2]).toBeCloseTo(pathDistanceM(coords), 6);
  });
});

describe('elevationStats', () => {
  it('sums real climbs and descents', () => {
    const coords: LonLatEle[] = [
      [6.5, 44.6, 1000],
      [6.5, 44.6, 1100],
      [6.5, 44.6, 1050],
    ];
    expect(elevationStats(coords)).toEqual({ gainM: 100, lossM: 50 });
  });

  it('ignores DEM noise below the hysteresis', () => {
    const noisy: LonLatEle[] = Array.from({ length: 50 }, (_, i) => [6.5, 44.6, 1000 + (i % 2 === 0 ? 3 : -3)]);
    expect(elevationStats(noisy)).toEqual({ gainM: 0, lossM: 0 });
  });

  it('returns zeros on an empty track', () => {
    expect(elevationStats([])).toEqual({ gainM: 0, lossM: 0 });
  });
});

describe('formatting', () => {
  it('switches from meters to kilometers at 1 km', () => {
    expect(formatDistance(999)).toBe('999 m');
    expect(formatDistance(1000)).toBe('1.0 km');
    expect(formatDistance(12_345)).toBe('12.3 km');
  });

  it('renders durations without a leading zero hour', () => {
    expect(formatDuration(0.5)).toBe('30 min');
    expect(formatDuration(2.51)).toBe('2 h 31');
  });
});

describe('nearestIndex', () => {
  const sorted = [0, 100, 200, 300];

  it('finds the closest value, including out of range queries', () => {
    expect(nearestIndex(sorted, 0)).toBe(0);
    expect(nearestIndex(sorted, 149)).toBe(1);
    expect(nearestIndex(sorted, 151)).toBe(2);
    expect(nearestIndex(sorted, -50)).toBe(0);
    expect(nearestIndex(sorted, 9999)).toBe(3);
  });
});

describe('simplifyIndices', () => {
  it('keeps only the endpoints of a straight line', () => {
    const straight: LonLatEle[] = Array.from({ length: 20 }, (_, i) => [6.5 + i * 0.001, 44.6, 1000]);
    expect(simplifyIndices(straight, 25)).toEqual([0, 19]);
  });

  it('keeps a sharp detour and always both endpoints', () => {
    const detour: LonLatEle[] = [
      [6.5, 44.6, 1000],
      [6.5, 44.61, 1000],
      [6.51, 44.6, 1000],
    ];
    const kept = simplifyIndices(detour, 25);
    expect(kept).toContain(0);
    expect(kept).toContain(1);
    expect(kept).toContain(2);
  });

  it('passes through tracks of two points or fewer', () => {
    expect(simplifyIndices([], 25)).toEqual([]);
    expect(
      simplifyIndices(
        [
          [6.5, 44.6, 0],
          [6.6, 44.6, 0],
        ],
        25,
      ),
    ).toEqual([0, 1]);
  });

  it('drops more vertices as the tolerance grows', () => {
    const wiggly: LonLatEle[] = Array.from({ length: 60 }, (_, i) => [
      6.5 + i * 0.0005,
      44.6 + (i % 2 === 0 ? 0.0002 : -0.0002),
      1000,
    ]);
    expect(simplifyIndices(wiggly, 100).length).toBeLessThanOrEqual(simplifyIndices(wiggly, 5).length);
  });
});

describe('pointToPathDistanceM', () => {
  const path: LonLatEle[] = [
    [6.5, 44.6, 1000],
    [6.6, 44.6, 1000],
  ];

  it('is zero on the path and positive beside it', () => {
    expect(pointToPathDistanceM([6.55, 44.6, 1000], path)).toBeCloseTo(0, 3);
    expect(pointToPathDistanceM([6.55, 44.61, 1000], path)).toBeGreaterThan(1000);
  });

  it('clamps to segment ends rather than to the infinite line', () => {
    const beyond = pointToPathDistanceM([6.7, 44.6, 1000], path);
    const toLastVertex = haversineM([6.7, 44.6], [6.6, 44.6]);
    // local planar projection, so a fraction of a percent of drift over 8 km is expected
    expect(beyond / toLastVertex).toBeCloseTo(1, 2);
  });
});

describe('kmMarkerPoints', () => {
  it('places one marker per step, numbered from the start and staying on the track', () => {
    const coords: LonLatEle[] = [
      [6.5, 44.6, 1000],
      [6.5, 44.69, 1000],
    ];
    const dists = cumulativeDistancesM(coords);
    const totalKm = dists.at(-1) as number;
    const markers = kmMarkerPoints(coords, dists, 1000);

    expect(markers.map(m => m.km)).toEqual(Array.from({ length: markers.length }, (_, i) => i + 1));
    expect(markers.length).toBe(Math.floor(totalKm / 1000));
    expect(markers.every(m => m.lat > 44.6 && m.lat <= 44.69)).toBe(true);
    expect(markers.every(m => m.lon === 6.5)).toBe(true);
  });

  it('spaces markers out when the step grows', () => {
    const coords: LonLatEle[] = [
      [6.5, 44.6, 1000],
      [6.5, 44.9, 1000],
    ];
    const dists = cumulativeDistancesM(coords);
    const every5km = kmMarkerPoints(coords, dists, 5000);
    expect(every5km.map(m => m.km)).toEqual([5, 10, 15, 20, 25, 30]);
  });

  it('returns nothing when the track is shorter than one step', () => {
    const coords: LonLatEle[] = [
      [6.5, 44.6, 1000],
      [6.5001, 44.6, 1000],
    ];
    expect(kmMarkerPoints(coords, cumulativeDistancesM(coords), 1000)).toEqual([]);
  });
});
