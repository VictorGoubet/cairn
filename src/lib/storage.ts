import type { Anchor, LegSlot, OffRoutePoint, SavedRoute } from '../store';
import { DEFAULT_PROFILE, type HikerPace, type HikerProfile } from './hikingTime';
import { parseKind } from './points';

const PACES: HikerPace[] = ['strolling', 'steady', 'sporty', 'athletic'];

const ROUTES_KEY = 'cairn.routes.v1';
const DRAFT_KEY = 'cairn.draft.v1';
const PROFILE_KEY = 'cairn.profile.v1';

export interface Draft {
  anchors: Anchor[];
  legs: LegSlot[];
  offRoutePoints: OffRoutePoint[];
  currentRouteId: string | null;
  currentRouteName: string;
}

// legacy data: free points dropped by right-click were stored under "waypoints"
type LegacyWaypoints = { waypoints?: OffRoutePoint[] };

export function loadRoutes(): SavedRoute[] {
  const routes = readJson<(SavedRoute & LegacyWaypoints)[]>(ROUTES_KEY);
  if (!Array.isArray(routes)) return [];
  // a damaged route is dropped, the healthy ones around it survive
  return routes.flatMap(r => {
    if (typeof r !== 'object' || r === null) return [];
    const { waypoints, ...route } = r;
    const shape = sanitizeRouteShape(route, waypoints);
    // a saved route reduced to nothing is an entry, not a route
    if (shape.anchors.length === 0 && shape.offRoutePoints.length === 0) return [];
    return [
      {
        id: typeof route.id === 'string' ? route.id : crypto.randomUUID(),
        name: typeof route.name === 'string' ? route.name : '',
        updatedAt: typeof route.updatedAt === 'string' ? route.updatedAt : new Date(0).toISOString(),
        distanceM: Number.isFinite(route.distanceM) ? route.distanceM : 0,
        gainM: Number.isFinite(route.gainM) ? route.gainM : 0,
        ...shape,
      },
    ];
  });
}

export function persistRoutes(routes: SavedRoute[]): boolean {
  return writeJson(
    ROUTES_KEY,
    routes.map(r => ({ ...r, legs: compactLegs(r.legs) })),
  );
}

export function loadProfile(): HikerProfile | null {
  const stored = readJson<Partial<HikerProfile>>(PROFILE_KEY);
  if (!stored) return null;
  // a hand-edited or stale entry must not poison the estimates
  const pace = PACES.includes(stored.pace as HikerPace) ? (stored.pace as HikerPace) : DEFAULT_PROFILE.pace;
  return {
    pace,
    weightKg: clamp(stored.weightKg, 30, 200, DEFAULT_PROFILE.weightKg),
    packKg: clamp(stored.packKg, 0, 60, DEFAULT_PROFILE.packKg),
  };
}

export function persistProfile(profile: HikerProfile): boolean {
  return writeJson(PROFILE_KEY, profile);
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export function loadDraft(): Draft | null {
  const draft = readJson<Draft & LegacyWaypoints>(DRAFT_KEY);
  if (!draft || typeof draft !== 'object') return null;
  const { waypoints, ...rest } = draft;
  return {
    currentRouteId: typeof rest.currentRouteId === 'string' ? rest.currentRouteId : null,
    currentRouteName: typeof rest.currentRouteName === 'string' ? rest.currentRouteName : '',
    ...sanitizeRouteShape(rest, waypoints),
  };
}

export function persistDraft(draft: Draft): boolean {
  return writeJson(DRAFT_KEY, { ...draft, legs: compactLegs(draft.legs) });
}

/**
 * The route-shaped core of a draft or a saved route, structurally validated.
 *
 * Anything in localStorage may have been hand-edited or half-written: a point without real
 * coordinates is dropped, and when the legs no longer line up with the anchors (one per pair)
 * they are rebuilt as empty slots that the router recomputes on load. Whatever survives is
 * usable; crashing at boot over a torn entry is the one outcome this forbids.
 */
function sanitizeRouteShape(
  entry: { anchors?: unknown; legs?: unknown; offRoutePoints?: unknown },
  legacy: unknown,
): { anchors: Anchor[]; legs: LegSlot[]; offRoutePoints: OffRoutePoint[] } {
  const anchors = (Array.isArray(entry.anchors) ? entry.anchors : []).map(migrateAnchor).filter(a => a !== null);

  const rawLegs = Array.isArray(entry.legs) ? entry.legs : [];
  let legs = rawLegs.map(sanitizeLeg).filter(l => l !== null);
  if (legs.length !== rawLegs.length || legs.length !== Math.max(anchors.length - 1, 0)) {
    legs = Array.from({ length: Math.max(anchors.length - 1, 0) }, () => ({
      id: crypto.randomUUID(),
      manual: false,
      leg: null,
    }));
  }

  const offRoute = [
    ...(Array.isArray(entry.offRoutePoints) ? entry.offRoutePoints : []),
    ...(Array.isArray(legacy) ? legacy : []),
  ]
    .map(migrateAnchor)
    .filter(p => p !== null);
  return { anchors, legs, offRoutePoints: offRoute };
}

// oldest drafts stored points as bare [lon, lat] tuples, without metadata
function migrateAnchor(a: unknown): Anchor | null {
  if (Array.isArray(a) && Number.isFinite(a[0]) && Number.isFinite(a[1])) {
    return { id: crypto.randomUUID(), lon: a[0], lat: a[1], kind: 'checkpoint', name: '' };
  }
  if (typeof a !== 'object' || a === null) return null;
  const p = a as Partial<Anchor>;
  if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat)) return null;
  return {
    id: typeof p.id === 'string' ? p.id : crypto.randomUUID(),
    lon: p.lon as number,
    lat: p.lat as number,
    kind: parseKind(p.kind),
    name: typeof p.name === 'string' ? p.name : '',
  };
}

function sanitizeLeg(slot: unknown): LegSlot | null {
  if (typeof slot !== 'object' || slot === null) return null;
  const raw = slot as Partial<LegSlot>;
  let leg: LegSlot['leg'] = null;
  if (raw.leg && typeof raw.leg === 'object') {
    const coords = Array.isArray(raw.leg.coords)
      ? raw.leg.coords.filter(
          (c): c is [number, number, number] =>
            Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1]) && Number.isFinite(c[2]),
        )
      : [];
    if (coords.length >= 2) {
      leg = {
        coords,
        distanceM: Number.isFinite(raw.leg.distanceM) ? raw.leg.distanceM : 0,
        waySegments: Array.isArray(raw.leg.waySegments) ? raw.leg.waySegments : undefined,
      };
    }
  }
  return {
    id: typeof raw.id === 'string' ? raw.id : crypto.randomUUID(),
    manual: raw.manual === true,
    leg,
  };
}

// rounds coordinates (~10 cm) to stay well within the localStorage quota
function compactLegs(legs: LegSlot[]): LegSlot[] {
  return legs.map(slot =>
    slot.leg
      ? {
          ...slot,
          leg: {
            distanceM: Math.round(slot.leg.distanceM),
            coords: slot.leg.coords.map(
              c => [Number(c[0].toFixed(6)), Number(c[1].toFixed(6)), Math.round(c[2] * 10) / 10] as typeof c,
            ),
          },
        }
      : slot,
  );
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson<T>(key: string, value: T): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
