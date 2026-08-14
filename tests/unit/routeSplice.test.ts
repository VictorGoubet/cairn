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
  it('splits the leg in two and snaps the new anchor onto the track', () => {
    const anchors = [anchor(6.5, 44.6), anchor(6.51, 44.6)];
    const legs = [leg()];
    const result = spliceIntoTrace(anchors, legs, [6.5052, 44.6009], anchor(6.5052, 44.6009));

    expect(result).not.toBeNull();
    const spliced = result as NonNullable<typeof result>;
    expect(spliced.anchors).toHaveLength(3);
    expect(spliced.legs).toHaveLength(2);
    // snapped on an existing vertex, so exactly on the track
    expect(spliced.anchors[1].lat).toBe(44.6);
    expect(spliced.anchors[1].lon).toBeCloseTo(6.505, 6);
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

  it('never produces an empty half, even when clicking on a leg endpoint', () => {
    for (const target of [
      [6.5, 44.6],
      [6.51, 44.6],
    ] as [number, number][]) {
      const result = spliceIntoTrace([anchor(6.5, 44.6), anchor(6.51, 44.6)], [leg()], target, anchor(target[0], target[1]));
      const spliced = result as NonNullable<typeof result>;
      expect((spliced.legs[0].leg?.coords.length as number) >= 2).toBe(true);
      expect((spliced.legs[1].leg?.coords.length as number) >= 2).toBe(true);
    }
  });
});
