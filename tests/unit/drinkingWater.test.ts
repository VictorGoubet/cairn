import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDrinkingWater } from '../../src/lib/drinkingWater';

/** distinct areas (the module memoizes per cell), each small enough to fit one z10 cell */
const VINCENNES = { west: 2.43, south: 48.83, east: 2.44, north: 48.84 };
const LYON = { west: 4.84, south: 45.75, east: 4.85, north: 45.76 };

const ELEMENTS = {
  elements: [
    { type: 'node', lon: 2.43, lat: 48.83, tags: { name: 'Fontaine Wallace' } },
    { type: 'node', lon: 2.44, lat: 48.84 },
    { type: 'node', lon: Number.NaN, lat: 48.84 },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchDrinkingWater', () => {
  it('asks overpass for public fountains and shapes them like refuges.info points', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(ELEMENTS)));
    vi.stubGlobal('fetch', fetchMock);

    const points = await fetchDrinkingWater(VINCENNES);
    const body = String((fetchMock.mock.calls[0][1] as RequestInit).body);
    expect(body).toContain('drinking_water');
    // a private tap behind a fence quenches nobody
    expect(body).toContain('access');
    expect(points).toHaveLength(2);
    expect(points[0].properties).toMatchObject({ nom: 'Fontaine Wallace', cat: 'water' });
    expect(points[1].properties?.nom).toBe('');
  });

  it('keeps the map alive when overpass refuses', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));
    expect(await fetchDrinkingWater(LYON)).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('asks for nothing when the view spans too many cells', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchDrinkingWater({ west: -5, south: 41, east: 10, north: 51 })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
