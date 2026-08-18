import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRefugePoints } from '../../src/lib/refugesInfo';

/** a cell of the Queyras, and neighbours: the module memoizes per cell, so each test needs its own */
const QUEYRAS = { west: 6.6, south: 44.6, east: 6.9, north: 44.75 };
const VANOISE = { west: 6.6, south: 45.3, east: 6.9, north: 45.45 };
const OISANS = { west: 6.0, south: 45.0, east: 6.3, north: 45.15 };

const COLLECTION = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {
        nom: 'Source Cabane de Clausis',
        type: { id: 23, valeur: "point d'eau" },
        coord: { alt: 2435 },
        lien: 'https://www.refuges.info/point/10003/',
      },
      geometry: { type: 'Point', coordinates: [6.78, 44.68] },
    },
    {
      type: 'Feature',
      properties: { nom: 'Cabane du Berger', type: { valeur: 'cabane non gardée' }, coord: { alt: 2100 } },
      geometry: { type: 'Point', coordinates: [6.8, 44.7] },
    },
    {
      type: 'Feature',
      properties: { nom: 'Chose', type: { valeur: 'bâtiment en montagne' } },
      geometry: { type: 'Point', coordinates: [6.81, 44.71] },
    },
  ],
};

function mockFetch(body: string, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fetchRefugePoints', () => {
  it('asks for the whole cell and maps huts, water points and the rest', async () => {
    const fetchMock = mockFetch(JSON.stringify(COLLECTION));
    const points = await fetchRefugePoints(QUEYRAS);

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('format=geojson');
    // `type_points` takes numeric ids: any word there makes the API reject the whole query
    expect(url).not.toContain('type_points');
    expect(points.map(p => p.properties?.cat)).toEqual(['water', 'hut', 'other']);
    expect(points[0].properties?.nom).toBe('Source Cabane de Clausis');
    expect(points[0].properties?.alt).toBe(2435);
  });

  it('treats a plain-text answer as the failure it is, not as an empty area', async () => {
    // refuges.info answers 200 with `Error : no valid type : all` when a parameter is wrong; an
    // ok status is no proof, and a silent empty list is how a broken overlay stays broken
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch('Error : no valid type : all');

    expect(await fetchRefugePoints(VANOISE)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][1])).toMatch(/refused the query/);
  });

  it('keeps the map alive when the API is down', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch('gateway timeout', 504);
    expect(await fetchRefugePoints(OISANS)).toEqual([]);
  });

  it('asks for nothing when the view spans too many cells', async () => {
    const fetchMock = mockFetch(JSON.stringify(COLLECTION));
    expect(await fetchRefugePoints({ west: -5, south: 41, east: 10, north: 51 })).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
