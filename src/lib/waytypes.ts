/**
 * Analyse des voies empruntées par un itinéraire (type, surface, cotation SAC).
 *
 * BRouter renvoie dans chaque réponse un tableau `messages` avec, segment par segment,
 * les tags OSM de la voie empruntée (highway=, surface=, sac_scale=…) et le point de fin
 * du segment. C'est la même donnée que les fonctionnalités « types de voies » d'OpenRunner
 * ou de Komoot, sans requête supplémentaire.
 */

import type { LonLatEle } from './geo';

export type WayCategory = 'path' | 'track' | 'minor_road' | 'road' | 'unknown';
export type SurfaceCategory = 'paved' | 'gravel' | 'ground' | 'unknown';

export interface WaySegment {
  category: WayCategory;
  surface: SurfaceCategory;
  /** cotation SAC (0 = non renseignée, 1..6 = T1..T6) */
  sac: number;
  distanceM: number;
  /** index (dans les coords du tronçon) du dernier point couvert par ce segment */
  endIndex: number;
}

/** ordre d'affichage: du plus recherché (sentier) au moins renseigné */
export const WAY_CATEGORIES: readonly WayCategory[] = ['path', 'track', 'minor_road', 'road', 'unknown'];
export const SURFACE_CATEGORIES: readonly SurfaceCategory[] = ['ground', 'gravel', 'paved', 'unknown'];

/** couleurs partagées entre les barres du panneau et la surbrillance sur la carte */
export const WAY_COLORS: Record<WayCategory, string> = {
  path: '#2f9e44',
  track: '#a07850',
  minor_road: '#8895a7',
  road: '#f08c00',
  unknown: '#ced4da',
};
export const SURFACE_COLORS: Record<SurfaceCategory, string> = {
  ground: '#66a80f',
  gravel: '#b8926a',
  paved: '#495057',
  unknown: '#ced4da',
};

/** seuil au-delà duquel on alerte: T3 = randonnée en montagne exigeante */
export const SAC_WARNING_LEVEL = 3;

const COORD_MATCH_TOLERANCE = 5e-6;
const PATH_HIGHWAYS = new Set(['path', 'footway', 'steps', 'bridleway', 'via_ferrata']);
const MINOR_ROAD_HIGHWAYS = new Set([
  'service',
  'residential',
  'unclassified',
  'living_street',
  'pedestrian',
  'cycleway',
  'road',
]);
const PAVED_SURFACES = new Set([
  'asphalt',
  'paved',
  'concrete',
  'paving_stones',
  'sett',
  'cobblestone',
  'metal',
  'wood',
]);
const GRAVEL_SURFACES = new Set(['gravel', 'fine_gravel', 'compacted', 'pebblestone']);
const SAC_LEVELS: Record<string, number> = {
  hiking: 1,
  mountain_hiking: 2,
  demanding_mountain_hiking: 3,
  alpine_hiking: 4,
  demanding_alpine_hiking: 5,
  difficult_alpine_hiking: 6,
};

/**
 * Extrait les segments de voie du tableau `messages` d'une réponse BRouter.
 *
 * Args:
 *   messages: lignes brutes (la première est l'en-tête des colonnes).
 *   coords: géométrie du tronçon, pour situer la fin de chaque segment (les messages
 *     donnent le point de fin en microdegrés, présent tel quel dans la géométrie).
 *
 * Returns:
 *   Un segment par ligne de message, ou undefined si le format est inattendu.
 */
export function parseWaySegments(messages: string[][] | undefined, coords: LonLatEle[]): WaySegment[] | undefined {
  if (!messages || messages.length < 2) return undefined;
  const header = messages[0];
  const lonCol = header.indexOf('Longitude');
  const latCol = header.indexOf('Latitude');
  const distanceCol = header.indexOf('Distance');
  const tagsCol = header.indexOf('WayTags');
  if (lonCol < 0 || latCol < 0 || distanceCol < 0 || tagsCol < 0) return undefined;

  const segments: WaySegment[] = [];
  let searchFrom = 0;
  for (const row of messages.slice(1)) {
    const distanceM = Number(row[distanceCol]);
    if (!Number.isFinite(distanceM) || distanceM <= 0) continue;
    const tags = tagValues(row[tagsCol] ?? '');
    const endIndex = findCoordIndex(coords, Number(row[lonCol]) / 1e6, Number(row[latCol]) / 1e6, searchFrom);
    if (endIndex >= 0) searchFrom = endIndex;
    segments.push({
      category: categoryFromHighway(tags.get('highway')),
      surface: surfaceCategory(tags.get('surface')),
      sac: SAC_LEVELS[tags.get('sac_scale') ?? ''] ?? 0,
      distanceM,
      endIndex: endIndex >= 0 ? endIndex : searchFrom,
    });
  }
  return segments.length > 0 ? segments : undefined;
}

/**
 * Agrège les distances par valeur d'une dimension (type de voie ou surface).
 *
 * Args:
 *   legs: tronçons résolus; ceux sans analyse (manuels, importés non matchés) comptent en `unknown`.
 *   dimension: champ de WaySegment à agréger.
 */
export function aggregateBy(
  legs: ReadonlyArray<{ waySegments?: WaySegment[]; distanceM: number } | null | undefined>,
  dimension: 'category' | 'surface',
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const leg of legs) {
    if (!leg) continue;
    if (!leg.waySegments) {
      totals.unknown = (totals.unknown ?? 0) + leg.distanceM;
      continue;
    }
    for (const seg of leg.waySegments) {
      totals[seg[dimension]] = (totals[seg[dimension]] ?? 0) + seg.distanceM;
    }
  }
  return totals;
}

/**
 * Cotation SAC maximale de l'itinéraire et distance cumulée au niveau d'alerte.
 *
 * Args:
 *   legs: tronçons résolus.
 */
export function sacStats(legs: ReadonlyArray<{ waySegments?: WaySegment[] } | null | undefined>): {
  maxSac: number;
  warningDistanceM: number;
} {
  let maxSac = 0;
  let warningDistanceM = 0;
  for (const leg of legs) {
    for (const seg of leg?.waySegments ?? []) {
      maxSac = Math.max(maxSac, seg.sac);
      if (seg.sac >= SAC_WARNING_LEVEL) warningDistanceM += seg.distanceM;
    }
  }
  return { maxSac, warningDistanceM };
}

function tagValues(tags: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const tag of tags.split(' ')) {
    const eq = tag.indexOf('=');
    if (eq > 0) out.set(tag.slice(0, eq), tag.slice(eq + 1));
  }
  return out;
}

function categoryFromHighway(highway: string | undefined): WayCategory {
  if (!highway) return 'unknown';
  if (PATH_HIGHWAYS.has(highway)) return 'path';
  if (highway === 'track') return 'track';
  if (MINOR_ROAD_HIGHWAYS.has(highway)) return 'minor_road';
  return 'road';
}

function surfaceCategory(surface: string | undefined): SurfaceCategory {
  if (!surface) return 'unknown';
  if (PAVED_SURFACES.has(surface)) return 'paved';
  if (GRAVEL_SURFACES.has(surface)) return 'gravel';
  return 'ground';
}

// la fin de segment est un sommet exact de la géométrie: recherche en avançant seulement
function findCoordIndex(coords: LonLatEle[], lon: number, lat: number, from: number): number {
  for (let i = from; i < coords.length; i++) {
    if (Math.abs(coords[i][0] - lon) < COORD_MATCH_TOLERANCE && Math.abs(coords[i][1] - lat) < COORD_MATCH_TOLERANCE) {
      return i;
    }
  }
  return -1;
}
