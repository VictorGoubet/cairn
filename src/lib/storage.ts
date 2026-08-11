import type { Anchor, LegSlot, OffRoutePoint, SavedRoute } from '../store';

const ROUTES_KEY = 'cairn.routes.v1';
const DRAFT_KEY = 'cairn.draft.v1';

export interface Draft {
  anchors: Anchor[];
  legs: LegSlot[];
  offRoutePoints: OffRoutePoint[];
  currentRouteId: string | null;
  currentRouteName: string;
}

// anciennes données: les points libres posés au clic droit étaient stockés sous "waypoints"
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

// les anciens brouillons stockaient les points en tuples [lon, lat] sans métadonnées,
// et le type "etape" a fusionné avec "bivouac"
function migrateAnchors(anchors: (Anchor | [number, number])[] | undefined): Anchor[] {
  return (anchors ?? []).map(a =>
    Array.isArray(a)
      ? { id: crypto.randomUUID(), lon: a[0], lat: a[1], kind: 'checkpoint' as const, name: '' }
      : { ...a, kind: migrateKind(a.kind) },
  );
}

// les anciens "waypoints" libres sont exactement les points hors tracé d'aujourd'hui
function migrateOffRoutePoints(
  points: OffRoutePoint[] | undefined,
  legacy: OffRoutePoint[] | undefined,
): OffRoutePoint[] {
  return [...(points ?? []), ...(legacy ?? [])].map(w => ({ ...w, kind: migrateKind(w.kind) }));
}

function migrateKind(kind: string | undefined): Anchor['kind'] {
  if (kind === 'etape') return 'bivouac';
  return (kind as Anchor['kind']) ?? 'autre';
}

// arrondit les coordonnées (~10 cm) pour tenir large dans le quota localStorage
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
