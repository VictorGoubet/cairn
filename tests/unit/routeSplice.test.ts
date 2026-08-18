import { describe, expect, it } from 'vitest';
import { pathDistanceM } from '../../src/lib/geo';
import { spliceIntoTrace } from '../../src/lib/routeSplice';
import type { Anchor, LegSlot } from '../../src/store';

function anchor(lon: number, lat: number): Anchor {
  return { id: crypto.randomUUID(), lon, lat, kind: 'checkpoint', name: '' };
}

/** straight leg of 11 vertices along a parallel, roughly 800 m */
function leg(manual = false): LegSlot {
  const coords = Array.from({ length: 11 }, (_, i) => [6.5 + i * 0.001, 44.6, 1000 + i] as [number, number, number]);
  return { id: crypto.randomUUID(), manual, leg: { coords, distanceM: pathDistanceM(coords) } };
}

describe('spliceIntoTrace', () => {
  it('splits the leg in two and puts the new anchor on the track, where it was clicked', () => {
    const anchors = [anchor(6.5, 44.6), anchor(6.51, 44.6)];
    const legs = [leg()];
    const result = spliceIntoTrace(anchors, legs, [6.5052, 44.6009], anchor(6.5052, 44.6009));

    expect(result).not.toBeNull();
    const spliced = result as NonNullable<typeof result>;
    expect(spliced.anchors).toHaveLength(3);
    expect(spliced.legs).toHaveLength(2);
    // projected onto the trace: on the line in latitude, at the clicked longitude
    expect(spliced.anchors[1].lat).toBeCloseTo(44.6, 6);
    expect(spliced.anchors[1].lon).toBeCloseTo(6.5052, 6);
  });

  it('preserves the geometry: the two halves share the split vertex and keep the total length', () => {
    const original = leg();
    const result = spliceIntoTrace([anchor(6.5, 44.6), anchor(6.51, 44.6)], [original], [6.505, 44.6], anchor(6.505, 44.6));
    const spliced = result as NonNullable<typeof result>;
    const before = spliced.legs[0].leg?.coords as [number, number, number][];
    const after = spliced.legs[1].leg?.coords as [number, number, number][];

    expect(before.at(-1)).toEqual(after[0]);
    expect(before.length + after.length).toBe((original.leg?.coords.length as number) + 1);
    const total = (spliced.legs[0].leg?.distanceM as number) + (spliced.legs[1].leg?.distanceM as number);
    expect(total).toBeCloseTo(original.leg?.distanceM as number, 6);
  });

  it('inserts into the closest leg and leaves the others untouched', () => {
    const first = leg();
    const second: LegSlot = {
      id: crypto.randomUUID(),
      manual: false,
      leg: {
        coords: Array.from({ length: 11 }, (_, i) => [6.6 + i * 0.001, 44.7, 1000] as [number, number, number]),
        distanceM: 800,
      },
    };
    const anchors = [anchor(6.5, 44.6), anchor(6.51, 44.6), anchor(6.61, 44.7)];
    const result = spliceIntoTrace(anchors, [first, second], [6.605, 44.7], anchor(6.605, 44.7));
    const spliced = result as NonNullable<typeof result>;

    expect(spliced.legs).toHaveLength(3);
    expect(spliced.legs[0]).toBe(first);
    expect(spliced.anchors[2].lat).toBe(44.7);
  });

  it('keeps the manual flag of the leg it splits', () => {
    const result = spliceIntoTrace([anchor(6.5, 44.6), anchor(6.51, 44.6)], [leg(true)], [6.505, 44.6], anchor(6.505, 44.6));
    const spliced = result as NonNullable<typeof result>;
    expect(spliced.legs[0].manual).toBe(true);
    expect(spliced.legs[1].manual).toBe(true);
  });

  it('gives up when no leg has a geometry yet', () => {
    const pending: LegSlot = { id: crypto.randomUUID(), manual: false, leg: null };
    expect(spliceIntoTrace([anchor(6.5, 44.6), anchor(6.51, 44.6)], [pending], [6.505, 44.6], anchor(6.505, 44.6))).toBeNull();
    expect(spliceIntoTrace([], [], [6.505, 44.6], anchor(6.505, 44.6))).toBeNull();
  });

  it('declines a click on a leg endpoint rather than making an empty half', () => {
    // there is already an anchor there: inserting a second one on the same spot would create a
    // zero-length leg, and doing nothing is what the click deserves
    for (const target of [
      [6.5, 44.6],
      [6.51, 44.6],
    ] as [number, number][]) {
      expect(spliceIntoTrace([anchor(6.5, 44.6), anchor(6.51, 44.6)], [leg()], target, anchor(target[0], target[1]))).toBeNull();
    }
  });

  it('splits a beeline leg, where there is no interior vertex to snap to', () => {
    // an imported route between two cache coordinates: two points, one straight leg. This used
    // to decline, and the click ended up appending a point at the far end of the route instead.
    const anchors = [anchor(6.5, 44.6), anchor(6.6, 44.66)];
    const straight: LegSlot = {
      id: 'straight',
      manual: true,
      leg: {
        coords: [
          [6.5, 44.6, 1000],
          [6.6, 44.66, 1200],
        ],
        distanceM: 11_000,
      },
    };
    const result = spliceIntoTrace(anchors, [straight], [6.55, 44.63], anchor(6.55, 44.63));

    expect(result).not.toBeNull();
    const spliced = result as NonNullable<typeof result>;
    expect(spliced.anchors).toHaveLength(3);
    expect(spliced.legs).toHaveLength(2);
    // the new anchor sits on the line, halfway, with an interpolated elevation
    expect(spliced.anchors[1].lon).toBeCloseTo(6.55, 3);
    expect(spliced.legs[0].leg?.coords.at(-1)?.[2]).toBeCloseTo(1100, 0);
  });

  it('cuts where the click projects, not at the nearest far vertex', () => {
    const anchors = [anchor(6.5, 44.6), anchor(6.6, 44.6)];
    const sparse: LegSlot = {
      id: 'sparse',
      manual: false,
      leg: {
        coords: [
          [6.5, 44.6, 1000],
          [6.6, 44.6, 1000],
        ],
        distanceM: 7900,
      },
    };
    // clicked just north of the line, a fifth of the way along
    const result = spliceIntoTrace(anchors, [sparse], [6.52, 44.6005], anchor(6.52, 44.6005));
    const spliced = result as NonNullable<typeof result>;
    expect(spliced.anchors[1].lon).toBeCloseTo(6.52, 3);
    expect(spliced.anchors[1].lat).toBeCloseTo(44.6, 3);
  });
});
