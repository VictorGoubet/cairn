import { describe, expect, it } from 'vitest';
import type { LonLat } from '../src/lib/geo';
import { clipAround, stitchWays } from '../src/lib/nearbyHikes';

/** ~111 m per 0.001 degree of latitude, which keeps the fixtures readable */
const at = (i: number): LonLat => [6.5, 44.6 + i * 0.001];

describe('stitchWays', () => {
  it('chains ways whatever their order and direction', () => {
    const a = [at(0), at(1)];
    const b = [at(3), at(2)]; // reversed on purpose
    const c = [at(2), at(1)]; // reversed on purpose
    const chain = stitchWays([a, b, c]);
    // one continuous line through the four points; which end it starts from is not ours to say
    expect(chain).toHaveLength(4);
    expect(chain.map(c => Math.round(c[1] * 1000) / 1000).sort()).toEqual([44.6, 44.601, 44.602, 44.603]);
    expect([chain[0][1], chain[3][1]].sort()).toEqual([at(0)[1], at(3)[1]].sort());
  });

  it('keeps the longest continuous stretch and drops a disconnected spur', () => {
    const main = [at(0), at(1), at(2), at(3)];
    const spur = [at(40), at(41)];
    expect(stitchWays([main, spur])).toHaveLength(main.length);
  });

  it('joins across a gap under the tolerance, not over it', () => {
    const first = [at(0), at(1)];
    // 0.0003 degrees is ~33 m, inside the default 60 m tolerance; the two ends fold into one
    // point, which is what a shared junction node needs
    const near: LonLat[][] = [
      first,
      [
        [6.5, 44.6013],
        [6.5, 44.6023],
      ],
    ];
    expect(stitchWays(near)).toHaveLength(3);
    // ~5 km apart: two separate itineraries, the longest one wins
    const far: LonLat[][] = [
      first,
      [
        [6.5, 44.65],
        [6.5, 44.66],
      ],
    ];
    expect(stitchWays(far)).toHaveLength(2);
  });

  it('returns nothing for an empty relation', () => {
    expect(stitchWays([])).toEqual([]);
  });
});

describe('clipAround', () => {
  const long = Array.from({ length: 200 }, (_, i) => at(i));

  it('leaves a track shorter than the budget alone', () => {
    const short = [at(0), at(1), at(2)];
    expect(clipAround(short, at(1), 45_000)).toBe(short);
  });

  it('keeps the budget around the point closest to the center', () => {
    const clipped = clipAround(long, at(100), 5_000);
    expect(clipped.length).toBeLessThan(long.length);
    const lats = clipped.map(c => c[1]);
    expect(Math.min(...lats)).toBeLessThan(at(100)[1]);
    expect(Math.max(...lats)).toBeGreaterThan(at(100)[1]);
  });

  it('clips at the start when the center sits at the start', () => {
    const clipped = clipAround(long, at(0), 5_000);
    expect(clipped[0][1]).toBeCloseTo(at(0)[1], 6);
    expect(clipped.length).toBeLessThan(long.length);
  });
});
