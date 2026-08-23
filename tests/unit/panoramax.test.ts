import { afterEach, describe, expect, it, vi } from 'vitest';
import { nearestGroundPhoto } from '../../src/lib/panoramax';

/** the spot the card is open on: Lac Miroir, where Panoramax really has photos */
const SPOT: [number, number] = [6.7922, 44.6344];

function answer(features: unknown[]) {
  return { ok: true, json: async () => ({ features }) } as Response;
}

function photo(id: string, lon: number, lat: number) {
  return {
    id,
    geometry: { coordinates: [lon, lat] },
    assets: { thumb: { href: `https://panoramax.openstreetmap.fr/${id}.jpg` } },
    properties: { 'geovisio:producer': 'Patchi', license: 'CC-BY-SA-4.0' },
  };
}

describe('nearestGroundPhoto', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the closest photo in range, with what CC-BY-SA asks for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer([photo('far', 6.7935, 44.6344), photo('near', 6.7925, 44.6344)])),
    );
    const found = await nearestGroundPhoto(SPOT);
    expect(found?.thumbUrl).toContain('near');
    expect(found?.author).toBe('Patchi');
    expect(found?.license).toBe('CC-BY-SA-4.0');
    expect(found?.viewerUrl).toContain('pic=near');
    expect(found?.distanceM).toBeLessThan(60);
  });

  it('says nothing rather than showing somewhere else', async () => {
    // in the bbox the server answers on, but past the radius the caller asked for
    vi.stubGlobal('fetch', vi.fn(async () => answer([photo('yonder', 6.7922, 44.6371)])));
    expect(await nearestGroundPhoto(SPOT, 250)).toBeNull();
  });

  it('degrades to no photo when the service is down or answers rubbish', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response));
    expect(await nearestGroundPhoto(SPOT)).toBeNull();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await nearestGroundPhoto(SPOT)).toBeNull();
  });
});
