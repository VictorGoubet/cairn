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

  it('offers the neighbour national map where there is one, the world topo otherwise', () => {
    expect(baseCovering(7.75, 46.02)).toBe('swisstopo'); // Zermatt
    expect(baseCovering(5.5, 50.3)).toBe('ngi-be'); // Ardennes
    expect(baseCovering(11.8, 46.5)).toBe('opentopo'); // Dolomites
    expect(baseCovering(-3.2, 40.4)).toBe('opentopo'); // Madrid
  });
});
