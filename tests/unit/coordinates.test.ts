import { describe, expect, it } from 'vitest';
import { formatCoordinates, parseCoordinates } from '../../src/lib/coordinates';

describe('parseCoordinates', () => {
  it('reads decimal degrees, latitude first', () => {
    expect(parseCoordinates('44.6318, 6.7752')).toEqual([6.7752, 44.6318]);
    expect(parseCoordinates('44.6318 6.7752')).toEqual([6.7752, 44.6318]);
  });

  it('reads the degrees and decimal minutes of a geocaching listing', () => {
    const parsed = parseCoordinates('N 44° 37.908 E 006° 46.512');
    expect(parsed?.[1]).toBeCloseTo(44.6318, 4);
    expect(parsed?.[0]).toBeCloseTo(6.7752, 4);
  });

  it('reads degrees, minutes and seconds', () => {
    const parsed = parseCoordinates('44°37\'54"N 6°46\'30"E');
    expect(parsed?.[1]).toBeCloseTo(44.63167, 4);
    expect(parsed?.[0]).toBeCloseTo(6.775, 4);
  });

  it('honours the hemisphere whatever the axis order', () => {
    const lonFirst = parseCoordinates('E 006 46.512 N 44 37.908');
    expect(lonFirst?.[1]).toBeCloseTo(44.6318, 4);
    expect(lonFirst?.[0]).toBeCloseTo(6.7752, 4);
  });

  it('handles southern and western hemispheres, and the french O for west', () => {
    expect(parseCoordinates('S 33.9 W 18.4')).toEqual([-18.4, -33.9]);
    expect(parseCoordinates('N 44.6 O 1.5')).toEqual([-1.5, 44.6]);
    expect(parseCoordinates('-44.6, -1.5')).toEqual([-1.5, -44.6]);
  });

  it('reads a lone letter as trailing the number before it, the DMS convention', () => {
    // "44.6 W 1.5" is under-specified: the W is taken to qualify 44.6, which then reads as a
    // longitude, so the pair comes back as (lon -44.6, lat 1.5) rather than being invented
    expect(parseCoordinates('44.6 W 1.5')).toEqual([-44.6, 1.5]);
  });

  it('accepts the comma decimal separator', () => {
    expect(parseCoordinates('44,6318 6,7752')).toEqual([6.7752, 44.6318]);
  });

  it('rejects what it cannot read for sure', () => {
    expect(parseCoordinates('Ceillac')).toBeNull();
    expect(parseCoordinates('44.6318')).toBeNull();
    expect(parseCoordinates('44.6, 6.7, 1800')).toBeNull();
    // out of range: a typo, not a place
    expect(parseCoordinates('91.0, 6.7')).toBeNull();
    expect(parseCoordinates('44.6, 200.0')).toBeNull();
    // 61 minutes is not a coordinate either
    expect(parseCoordinates('N 44 61.0 E 6 46.5')).toBeNull();
  });
});

describe('formatCoordinates', () => {
  it('writes latitude first, five decimals', () => {
    expect(formatCoordinates([6.7752, 44.6318])).toBe('44.63180, 6.77520');
  });
});
