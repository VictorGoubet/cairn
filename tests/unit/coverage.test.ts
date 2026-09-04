import { describe, expect, it } from 'vitest';
import { baseCovering, baseCoversView } from '../../src/lib/coverage';

describe('where the french maps stop', () => {
  it('covers metropolitan france, corsica and the overseas departments', () => {
    expect(baseCoversView('plan-ign', 6.87, 45.92)).toBe(true); // Chamonix
    expect(baseCoversView('scan25', 9.15, 42.15)).toBe(true); // Corte, Corsica
    expect(baseCoversView('ortho', 55.5, -21.1)).toBe(true); // Piton des Neiges
    expect(baseCoversView('plan-ign', -52.3, 4.9)).toBe(true); // Guyane
  });

  it('stops at the border, and only for the french bases', () => {
    expect(baseCoversView('plan-ign', 7.75, 46.02)).toBe(false); // Zermatt
    expect(baseCoversView('scan25', 11.8, 46.5)).toBe(false); // Dolomites
    // a global or foreign base is never out of its element
    expect(baseCoversView('opentopo', 11.8, 46.5)).toBe(true);
    expect(baseCoversView('swisstopo', 7.75, 46.02)).toBe(true);
  });

  it('offers the neighbour national map where there is one, osm otherwise', () => {
    expect(baseCovering('plan-ign', 7.75, 46.02)).toEqual({ id: 'swisstopo', sameFamily: true }); // Zermatt
    expect(baseCovering('scan25', 5.5, 50.3)).toEqual({ id: 'ngi-be', sameFamily: true }); // Ardennes
    expect(baseCovering('plan-ign', 11.8, 46.5)).toEqual({ id: 'osm', sameFamily: true }); // Dolomites
    expect(baseCovering('scan25', -3.2, 40.4)).toEqual({ id: 'osm', sameFamily: true }); // Madrid
  });

  it('answers a request for photographs with photographs', () => {
    // aerial photos and a topographic sheet are not interchangeable: offering swisstopo to somebody
    // looking at imagery was a non sequitur, and the world imagery is what belongs there
    expect(baseCovering('ortho', 7.75, 46.02)).toEqual({ id: 's2cloudless', sameFamily: true });
    expect(baseCovering('ortho', 11.8, 46.5)).toEqual({ id: 's2cloudless', sameFamily: true });
    // and the world imagery is never itself out of its element
    expect(baseCoversView('s2cloudless', 11.8, 46.5)).toBe(true);
  });
});
