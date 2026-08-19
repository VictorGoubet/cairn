import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchPlaces } from '../../src/lib/geocode';

const IGN_EMPTY = { features: [] };
const IGN_RICH = {
  features: [1, 2, 3].map(i => ({
    geometry: { coordinates: [6.7 + i, 44.6] },
    properties: { name: `Lieu ${i}`, postcode: '05600', city: 'Ceillac', category: ['sommet'] },
  })),
};
const PHOTON = {
  features: [
    {
      geometry: { coordinates: [7.74, 46.02] },
      properties: { name: 'Zermatt', state: 'Valais', country: 'Suisse', osm_value: 'village' },
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('searchPlaces', () => {
  it('asks the world when france has nothing to say', async () => {
    const fetchMock = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      return new Response(JSON.stringify(url.includes('photon') ? PHOTON : IGN_EMPTY));
    });
    vi.stubGlobal('fetch', fetchMock);

    const results = await searchPlaces('Zermatt');
    expect(results.map(r => r.name)).toEqual(['Zermatt']);
    expect(results[0].detail).toContain('Suisse');
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes('photon.komoot.io'))).toBe(true);
  });

  it('never bothers the world when france answers well', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(IGN_RICH)));
    vi.stubGlobal('fetch', fetchMock);

    const results = await searchPlaces('Ceillac');
    expect(results).toHaveLength(3);
    expect(fetchMock.mock.calls.every(c => !String(c[0]).includes('photon'))).toBe(true);
  });

  it('survives both services being down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
    expect(await searchPlaces('nowhere')).toEqual([]);
  });
});
