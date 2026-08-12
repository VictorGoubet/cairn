import { describe, expect, it } from 'vitest';
import type { LonLatEle } from '../src/lib/geo';
import { aggregateBy, parseWaySegments, SAC_WARNING_LEVEL, sacStats, type WaySegment } from '../src/lib/waytypes';

const COORDS: LonLatEle[] = [
  [6.5, 44.6, 1000],
  [6.501, 44.6, 1010],
  [6.502, 44.6, 1020],
];

/** BRouter answers with a header row then one row per way segment, coordinates in microdegrees */
function messages(rows: string[][]): string[][] {
  return [['Longitude', 'Latitude', 'Elevation', 'Distance', 'WayTags'], ...rows];
}

describe('parseWaySegments', () => {
  it('classifies highway and surface tags, and resolves sac scale', () => {
    const segments = parseWaySegments(
      messages([
        ['6501000', '44600000', '1010', '80', 'highway=path surface=ground sac_scale=mountain_hiking'],
        ['6502000', '44600000', '1020', '120', 'highway=track surface=gravel'],
      ]),
      COORDS,
    ) as WaySegment[];

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ category: 'path', surface: 'ground', sac: 2, distanceM: 80, endIndex: 1 });
    expect(segments[1]).toMatchObject({ category: 'track', surface: 'gravel', sac: 0, distanceM: 120, endIndex: 2 });
  });

  it('maps every highway family onto a category', () => {
    const cases: [string, string][] = [
      ['highway=footway', 'path'],
      ['highway=steps', 'path'],
      ['highway=via_ferrata', 'path'],
      ['highway=track', 'track'],
      ['highway=residential', 'minor_road'],
      ['highway=cycleway', 'minor_road'],
      ['highway=primary', 'road'],
      ['', 'unknown'],
    ];
    for (const [tags, expected] of cases) {
      const segments = parseWaySegments(messages([['6501000', '44600000', '1010', '50', tags]]), COORDS) as WaySegment[];
      expect(segments[0].category, tags).toBe(expected);
    }
  });

  it('sorts surfaces into paved, gravel and ground', () => {
    const cases: [string, string][] = [
      ['surface=asphalt', 'paved'],
      ['surface=paving_stones', 'paved'],
      ['surface=compacted', 'gravel'],
      ['surface=dirt', 'ground'],
      ['', 'unknown'],
    ];
    for (const [tags, expected] of cases) {
      const segments = parseWaySegments(messages([['6501000', '44600000', '1010', '50', tags]]), COORDS) as WaySegment[];
      expect(segments[0].surface, tags).toBe(expected);
    }
  });

  it('rejects unusable payloads instead of guessing', () => {
    expect(parseWaySegments(undefined, COORDS)).toBeUndefined();
    expect(parseWaySegments([['Longitude', 'Latitude', 'Distance', 'WayTags']], COORDS)).toBeUndefined();
    // missing the columns we rely on
    expect(parseWaySegments([['Foo', 'Bar'], ['1', '2']], COORDS)).toBeUndefined();
    // zero length segments carry no information
    expect(parseWaySegments(messages([['6501000', '44600000', '1010', '0', 'highway=path']]), COORDS)).toBeUndefined();
  });
});

describe('aggregateBy', () => {
  const analysed = {
    distanceM: 200,
    waySegments: [
      { category: 'path', surface: 'ground', sac: 1, distanceM: 150, endIndex: 1 },
      { category: 'track', surface: 'gravel', sac: 0, distanceM: 50, endIndex: 2 },
    ] as WaySegment[],
  };

  it('sums distances per value', () => {
    expect(aggregateBy([analysed], 'category')).toEqual({ path: 150, track: 50 });
    expect(aggregateBy([analysed], 'surface')).toEqual({ ground: 150, gravel: 50 });
  });

  it('counts legs without analysis as unknown, and skips missing legs', () => {
    expect(aggregateBy([{ distanceM: 300 }, null, undefined], 'category')).toEqual({ unknown: 300 });
    expect(aggregateBy([analysed, { distanceM: 100 }], 'category')).toEqual({ path: 150, track: 50, unknown: 100 });
    expect(aggregateBy([], 'category')).toEqual({});
  });
});

describe('sacStats', () => {
  it('reports the hardest level and the distance at or above the warning level', () => {
    const legs = [
      {
        waySegments: [
          { category: 'path', surface: 'ground', sac: 2, distanceM: 100, endIndex: 1 },
          { category: 'path', surface: 'ground', sac: 4, distanceM: 250, endIndex: 2 },
        ] as WaySegment[],
      },
    ];
    expect(sacStats(legs)).toEqual({ maxSac: 4, warningDistanceM: 250 });
  });

  it('stays at zero without analysis', () => {
    expect(sacStats([null, undefined, {}])).toEqual({ maxSac: 0, warningDistanceM: 0 });
  });

  it('counts the warning level itself', () => {
    const atLimit = [
      { waySegments: [{ category: 'path', surface: 'ground', sac: SAC_WARNING_LEVEL, distanceM: 10, endIndex: 1 }] as WaySegment[] },
    ];
    expect(sacStats(atLimit).warningDistanceM).toBe(10);
  });
});
