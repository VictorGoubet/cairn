import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadDraft, loadRoutes, persistDraft, persistRoutes } from '../../src/lib/storage';
import type { Anchor, LegSlot, SavedRoute } from '../../src/store';

const DRAFT_KEY = 'cairn.draft.v1';
const ROUTES_KEY = 'cairn.routes.v1';

function anchor(lon: number, lat: number, kind: Anchor['kind'] = 'checkpoint'): Anchor {
  return { id: crypto.randomUUID(), lon, lat, kind, name: '' };
}

function leg(): LegSlot {
  return {
    id: crypto.randomUUID(),
    manual: false,
    leg: {
      coords: [
        [6.5, 44.6, 1000.44],
        [6.51, 44.6, 1010.55],
      ],
      distanceM: 792.6,
    },
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('draft round-trip', () => {
  it('persists and restores the route being edited', () => {
    const draft = {
      anchors: [anchor(6.5, 44.6), anchor(6.51, 44.6, 'water')],
      legs: [leg()],
      offRoutePoints: [{ id: crypto.randomUUID(), lon: 6.4, lat: 44.5, kind: 'hut' as const, name: 'Cabane' }],
      currentRouteId: 'route-1',
      startDate: null,
      currentRouteName: 'Tour du Mélezet',
    };
    expect(persistDraft(draft)).toBe(true);

    const restored = loadDraft();
    expect(restored?.currentRouteName).toBe('Tour du Mélezet');
    expect(restored?.anchors.map(a => a.kind)).toEqual(['checkpoint', 'water']);
    expect(restored?.offRoutePoints[0].kind).toBe('hut');
    expect(restored?.legs[0].leg?.coords).toHaveLength(2);
  });

  it('returns null when nothing is stored, and survives corrupted json', () => {
    expect(loadDraft()).toBeNull();
    localStorage.setItem(DRAFT_KEY, '{ not json');
    expect(loadDraft()).toBeNull();
  });

  it('rounds coordinates on write to stay within the storage quota', () => {
    persistDraft({
      anchors: [anchor(6.5, 44.6)],
      legs: [
        {
          id: 'l1',
          manual: false,
          leg: { coords: [[6.123456789, 44.987654321, 1234.5678]], distanceM: 12.3456 },
        },
      ],
      offRoutePoints: [],
      currentRouteId: null,
      startDate: null,
      currentRouteName: '',
    });
    const raw = JSON.parse(localStorage.getItem(DRAFT_KEY) as string);
    expect(raw.legs[0].leg.coords[0]).toEqual([6.123457, 44.987654, 1234.6]);
    expect(raw.legs[0].leg.distanceM).toBe(12);
  });
});

describe('saved routes', () => {
  it('persists and restores the list', () => {
    const route: SavedRoute = {
      id: 'r1',
      name: 'Ceillac',
      updatedAt: '2026-08-12T08:00:00.000Z',
      distanceM: 6500,
      gainM: 430,
      anchors: [anchor(6.5, 44.6), anchor(6.51, 44.6)],
      legs: [leg()],
      offRoutePoints: [],
    };
    expect(persistRoutes([route])).toBe(true);
    const restored = loadRoutes();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: 'r1', name: 'Ceillac', distanceM: 6500, gainM: 430 });
  });

  it('returns an empty list when nothing is stored', () => {
    expect(loadRoutes()).toEqual([]);
  });
});

describe('legacy data migration', () => {
  it('upgrades bare [lon, lat] anchors into checkpoints', () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ anchors: [[6.5, 44.6], [6.51, 44.6]], legs: [], offRoutePoints: [] }),
    );
    const restored = loadDraft();
    expect(restored?.anchors).toHaveLength(2);
    expect(restored?.anchors[0]).toMatchObject({ lon: 6.5, lat: 44.6, kind: 'checkpoint', name: '' });
    expect(restored?.anchors[0].id).toBeTruthy();
  });

  it('translates the french kinds stored by older versions', () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        anchors: [{ id: 'a', lon: 6.5, lat: 44.6, kind: 'eau', name: 'Source' }],
        legs: [],
        offRoutePoints: [{ id: 'o', lon: 6.4, lat: 44.5, kind: 'sommet', name: 'Pic' }],
      }),
    );
    const restored = loadDraft();
    expect(restored?.anchors[0].kind).toBe('water');
    expect(restored?.offRoutePoints[0].kind).toBe('summit');
  });

  it('moves the legacy "waypoints" list onto off-route points', () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        anchors: [],
        legs: [],
        waypoints: [{ id: 'w', lon: 6.4, lat: 44.5, kind: 'bivouac', name: 'Camp' }],
      }),
    );
    const restored = loadDraft();
    expect(restored?.offRoutePoints).toHaveLength(1);
    expect(restored?.offRoutePoints[0]).toMatchObject({ name: 'Camp', kind: 'camp' });
    expect((restored as unknown as { waypoints?: unknown }).waypoints).toBeUndefined();
  });

  it('migrates saved routes the same way as the draft', () => {
    localStorage.setItem(
      ROUTES_KEY,
      JSON.stringify([
        {
          id: 'r1',
          name: 'Vieux tracé',
          updatedAt: '2026-01-01T00:00:00.000Z',
          distanceM: 1000,
          gainM: 100,
          anchors: [{ id: 'a', lon: 6.5, lat: 44.6, kind: 'etape', name: 'Étape 1' }],
          legs: [],
          waypoints: [{ id: 'w', lon: 6.4, lat: 44.5, kind: 'refuge', name: 'Refuge' }],
        },
      ]),
    );
    const [route] = loadRoutes();
    expect(route.anchors[0].kind).toBe('camp');
    expect(route.offRoutePoints[0].kind).toBe('hut');
  });
});

describe('quota handling', () => {
  it('reports failure instead of throwing when the write is refused', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(persistDraft({ anchors: [], legs: [], offRoutePoints: [], currentRouteId: null, startDate: null,
      currentRouteName: '' })).toBe(
      false,
    );
    expect(persistRoutes([])).toBe(false);
  });

  it('reports failure instead of throwing when reading is refused', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(loadDraft()).toBeNull();
    expect(loadRoutes()).toEqual([]);
  });
});

describe('hostile stored data', () => {
  it('keeps the healthy saved routes when one entry is torn', () => {
    localStorage.setItem(
      ROUTES_KEY,
      JSON.stringify([
        'not a route',
        null,
        { id: 'ok', name: 'Bonne route', anchors: [{ id: 'a', lon: 6.5, lat: 44.6, kind: 'checkpoint', name: '' }], legs: [], offRoutePoints: [] },
        { id: 'torn', name: 'Cassée', anchors: 'lol', legs: 42, offRoutePoints: null },
      ]),
    );
    const routes = loadRoutes();
    expect(routes.map(r => r.name)).toEqual(['Bonne route']);
  });

  it('rebuilds the legs as empty slots when they no longer line up with the anchors', () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        anchors: [
          { id: 'a', lon: 6.5, lat: 44.6, kind: 'checkpoint', name: '' },
          { id: 'b', lon: 6.51, lat: 44.6, kind: 'checkpoint', name: '' },
        ],
        legs: [{ id: 'l', manual: false, leg: { distanceM: 'NaN' } }, null, 7],
      }),
    );
    const draft = loadDraft();
    expect(draft?.anchors).toHaveLength(2);
    expect(draft?.legs).toHaveLength(1);
    expect(draft?.legs[0].leg).toBeNull();
  });

  it('drops a point without real coordinates instead of crashing on it later', () => {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ anchors: [{ id: 'x' }, { id: 'a', lon: 6.5, lat: 44.6 }], legs: [], offRoutePoints: [null] }),
    );
    const draft = loadDraft();
    expect(draft?.anchors).toHaveLength(1);
    expect(draft?.offRoutePoints).toEqual([]);
  });
});
