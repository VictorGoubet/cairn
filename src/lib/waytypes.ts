/**
 * Analysis of the ways a route follows (type, surface, SAC scale).
 *
 * Every BRouter response carries a `messages` array with, segment by segment, the OSM tags
 * of the way being followed (highway=, surface=, sac_scale=...) and the segment end point.
 * This is the same data behind the "way types" features of OpenRunner or Komoot, with no
 * extra request.
 */

import type { LonLatEle } from './geo';

export type WayCategory = 'path' | 'track' | 'minor_road' | 'road' | 'unknown';
export type SurfaceCategory = 'paved' | 'gravel' | 'ground' | 'unknown';

export interface WaySegment {
  category: WayCategory;
  surface: SurfaceCategory;
  /** SAC scale (0 = unspecified, 1..6 = T1..T6) */
  sac: number;
  distanceM: number;
  /** index, within the leg coords, of the last point this segment covers */
  endIndex: number;
}

/** display order: from the most sought after (path) to the least documented */
export const WAY_CATEGORIES: readonly WayCategory[] = ['path', 'track', 'minor_road', 'road', 'unknown'];
export const SURFACE_CATEGORIES: readonly SurfaceCategory[] = ['ground', 'gravel', 'paved', 'unknown'];

/** colors shared between the panel bars and the map highlight */
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

/** threshold above which we warn: T3 = demanding mountain hiking */
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
 * Extracts way segments from the `messages` array of a BRouter response.
 *
 * Args:
 *   messages: raw rows (the first one is the column header).
 *   coords: leg geometry, used to locate the end of each segment (messages give the end
 *     point in microdegrees, present as is in the geometry).
 *
 * Returns:
 *   One segment per message row, or undefined if the format is unexpected.
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
 * Aggregates distances by the values of one dimension (way type or surface).
 *
 * Args:
 *   legs: resolved legs; those without analysis (manual, imported without a match) count as `unknown`.
 *   dimension: WaySegment field to aggregate on.
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
 * Highest SAC scale of the route and cumulated distance at or above the warning level.
 *
 * Args:
 *   legs: resolved legs.
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

// a segment end is an exact geometry vertex: search forward only
function findCoordIndex(coords: LonLatEle[], lon: number, lat: number, from: number): number {
  for (let i = from; i < coords.length; i++) {
    if (Math.abs(coords[i][0] - lon) < COORD_MATCH_TOLERANCE && Math.abs(coords[i][1] - lat) < COORD_MATCH_TOLERANCE) {
      return i;
    }
  }
  return -1;
}
