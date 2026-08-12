import type { Anchor, LegSlot, OffRoutePoint, SavedRoute } from '../store';
import { parseKind } from './points';

const ROUTES_KEY = 'cairn.routes.v1';
const DRAFT_KEY = 'cairn.draft.v1';

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
  const routes = readJson<(SavedRoute & LegacyWaypoints)[]>(ROUTES_KEY) ?? [];
  return routes.map(r => {
    const { waypoints, ...route } = r;
    return {
      ...route,
      anchors: migrateAnchors(route.anchors),
      offRoutePoints: migrateOffRoutePoints(route.offRoutePoints, waypoints),
    };
  });
}

export function persistRoutes(routes: SavedRoute[]): boolean {
  return writeJson(
    ROUTES_KEY,
    routes.map(r => ({ ...r, legs: compactLegs(r.legs) })),
  );
}

export function loadDraft(): Draft | null {
  const draft = readJson<Draft & LegacyWaypoints>(DRAFT_KEY);
  if (!draft) return null;
  const { waypoints, ...rest } = draft;
  return {
    ...rest,
    anchors: migrateAnchors(draft.anchors),
    offRoutePoints: migrateOffRoutePoints(draft.offRoutePoints, waypoints),
  };
}

export function persistDraft(draft: Draft): boolean {
  return writeJson(DRAFT_KEY, { ...draft, legs: compactLegs(draft.legs) });
}

// oldest drafts stored points as bare [lon, lat] tuples, without metadata
function migrateAnchors(anchors: (Anchor | [number, number])[] | undefined): Anchor[] {
  return (anchors ?? []).map(a =>
    Array.isArray(a)
      ? { id: crypto.randomUUID(), lon: a[0], lat: a[1], kind: 'checkpoint' as const, name: '' }
      : { ...a, kind: parseKind(a.kind) },
  );
}

// the old free "waypoints" are exactly today's off-route points
function migrateOffRoutePoints(
  points: OffRoutePoint[] | undefined,
  legacy: OffRoutePoint[] | undefined,
): OffRoutePoint[] {
  return [...(points ?? []), ...(legacy ?? [])].map(w => ({ ...w, kind: parseKind(w.kind) }));
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
