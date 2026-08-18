import { describe, expect, it } from 'vitest';
import { buildGpx } from '../../src/lib/gpx';
import { DEFAULT_PROFILE } from '../../src/lib/hikingTime';
import { computeStages } from '../../src/lib/stages';
import type { Anchor, LegSlot } from '../../src/store';

function anchor(lon: number, kind: Anchor['kind'] = 'checkpoint', name = ''): Anchor {
  return { id: crypto.randomUUID(), lon, lat: 44.6, kind, name };
}

function leg(fromLon: number, toLon: number): LegSlot {
  const coords: [number, number, number][] = [
    [fromLon, 44.6, 1000],
    [(fromLon + toLon) / 2, 44.6, 1100],
    [toLon, 44.6, 1050],
  ];
  return { id: crypto.randomUUID(), manual: false, leg: { coords, distanceM: (toLon - fromLon) * 79_000 } };
}

const ANCHORS = [anchor(6.5), anchor(6.55, 'camp', 'Refuge du Lac'), anchor(6.6, 'camp'), anchor(6.65)];
const LEGS = [leg(6.5, 6.55), leg(6.55, 6.6), leg(6.6, 6.65)];

describe('computeStages', () => {
  it('cuts one stage per camp, named after it, stats summed from its legs', () => {
    const stages = computeStages(ANCHORS, LEGS, DEFAULT_PROFILE);
    expect(stages).toHaveLength(3);
    expect(stages[0].name).toBe('Refuge du Lac');
    expect(stages.map(s => [s.fromAnchor, s.toAnchor])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    // shared junctions are not double counted
    expect(stages[0].coords).toHaveLength(3);
    expect(stages[0].distanceM).toBeCloseTo(0.05 * 79_000, 3);
    expect(stages[0].hours).toBeGreaterThan(0);
  });

  it('a walk without camps is a walk, not a trek of one stage', () => {
    expect(computeStages([anchor(6.5), anchor(6.6)], [leg(6.5, 6.6)], DEFAULT_PROFILE)).toEqual([]);
  });

  it('a camp as start or finish cuts nothing', () => {
    const anchors = [anchor(6.5, 'camp'), anchor(6.6, 'camp')];
    expect(computeStages(anchors, [leg(6.5, 6.6)], DEFAULT_PROFILE)).toEqual([]);
  });
});

describe('buildGpx with stages', () => {
  it('writes one named track per day, readable by any device', () => {
    const stages = computeStages(ANCHORS, LEGS, DEFAULT_PROFILE);
    const doc = new DOMParser().parseFromString(
      buildGpx('GR58', LEGS.flatMap(l => l.leg?.coords ?? []), [], stages),
      'application/xml',
    );
    expect(doc.querySelector('parsererror')).toBeNull();
    const names = [...doc.querySelectorAll('trk > name')].map(n => n.textContent);
    expect(names).toEqual(['Jour 1 · Refuge du Lac', 'Jour 2', 'Jour 3']);
    expect(doc.querySelectorAll('trk trkpt').length).toBeGreaterThan(6);
  });

  it('stays a single track when the route has no stages', () => {
    const doc = new DOMParser().parseFromString(
      buildGpx(
        'Boucle',
        [
          [6.5, 44.6, 1000],
          [6.6, 44.6, 1100],
        ],
        [],
      ),
      'application/xml',
    );
    expect(doc.querySelectorAll('trk')).toHaveLength(1);
    expect(doc.querySelector('trk > name')?.textContent).toBe('Boucle');
  });
});
