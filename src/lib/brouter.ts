import profileTemplate from '../config/hiking-mountain.brf?raw';
import { cumulativeDistancesM, haversineM, type LonLat, type LonLatEle } from './geo';
import { fetchWithTimeout } from './http';
import { parseWaySegments, type WaySegment } from './waytypes';

const BROUTER_URL = 'https://brouter.de/brouter';
const DEFAULT_PROFILE = 'hiking-mountain';

/** presets: documented switches of the hiking-mountain template */
const PRESET_PATCHES: Record<RoutingPreset, [RegExp, string][]> = {
  balanced: [],
  avoid_roads: [[/^assign {3}path_preference {10}0\.0/m, 'assign   path_preference          20.0']],
  easy_up: [[/^assign {3}consider_elevation {5}= false/m, 'assign   consider_elevation     = true']],
};

export type RoutingPreset = 'balanced' | 'avoid_roads' | 'easy_up';

export interface RouteLeg {
  coords: LonLatEle[];
  distanceM: number;
  /** way analysis; missing for manual legs or imported ones without a match */
  waySegments?: WaySegment[];
}

let activePreset: RoutingPreset = 'balanced';
// id of the custom profile uploaded to brouter.de; invalidated when the server expires it
let customProfileId: string | null = null;
let customProfileUpload: Promise<string> | null = null;

/**
 * Changes the preset used by the next routing calls.
 *
 * Args:
 *   preset: balanced (standard profile), avoid roads, or limit elevation gain.
 */
export function setRoutingPreset(preset: RoutingPreset): void {
  if (preset === activePreset) return;
  activePreset = preset;
  customProfileId = null;
  customProfileUpload = null;
}

export function getRoutingPreset(): RoutingPreset {
  return activePreset;
}

/**
 * Routes a chain of points in a single request (easy on the volunteer-run server).
 *
 * Args:
 *   points: at least two points; the intermediate ones are via points snapped to the network.
 */
export async function computeRoute(points: LonLat[]): Promise<RouteLeg> {
  const lonlats = points.map(p => `${p[0]},${p[1]}`).join('|');
  const profile = await resolveProfile();
  let res = await fetchWithTimeout(routeUrl(lonlats, profile));
  // a custom profile expired server-side is re-uploaded once before giving up
  if (!res.ok && profile !== DEFAULT_PROFILE) {
    customProfileId = null;
    customProfileUpload = null;
    res = await fetchWithTimeout(routeUrl(lonlats, await resolveProfile()));
  }
  if (!res.ok) throw new Error(`brouter ${res.status}`);
  const data = await res.json();
  const feature = data.features?.[0];
  if (!feature) throw new Error('brouter: empty response');
  const coords = feature.geometry.coordinates as LonLatEle[];
  return {
    coords,
    distanceM: Number(feature.properties['track-length']),
    waySegments: parseWaySegments(feature.properties.messages, coords),
  };
}

export async function computeLeg(from: LonLat, to: LonLat): Promise<RouteLeg> {
  return computeRoute([from, to]);
}

/**
 * Splits a multi-via route into legs, at the via points snapped by the router.
 *
 * Args:
 *   route: response of a computeRoute going through every point.
 *   anchors: requested points, in order (at least two).
 *
 * Returns:
 *   The split legs plus the snapped position of each point, or null if the split fails.
 */
export function splitRoute(route: RouteLeg, anchors: LonLat[]): { legs: RouteLeg[]; junctions: LonLat[] } | null {
  const { coords } = route;
  if (coords.length < 2 || anchors.length < 2) return null;
  const dists = cumulativeDistancesM(coords);

  // geometry point closest to each via, moving forward only
  const cuts: number[] = [0];
  for (const anchor of anchors.slice(1, -1)) {
    let best = -1;
    let bestD = Number.POSITIVE_INFINITY;
    for (let i = cuts[cuts.length - 1] + 1; i < coords.length - 1; i++) {
      const d = haversineM([coords[i][0], coords[i][1]], anchor);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0) return null;
    cuts.push(best);
  }
  cuts.push(coords.length - 1);

  const legs: RouteLeg[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const [a, b] = [cuts[i], cuts[i + 1]];
    const waySegments: WaySegment[] = [];
    let prevEnd = 0;
    for (const seg of route.waySegments ?? []) {
      const overlapStart = Math.max(prevEnd, a);
      const overlapEnd = Math.min(seg.endIndex, b);
      prevEnd = seg.endIndex;
      if (overlapEnd <= overlapStart) continue;
      waySegments.push({ ...seg, distanceM: dists[overlapEnd] - dists[overlapStart], endIndex: overlapEnd - a });
    }
    legs.push({
      coords: coords.slice(a, b + 1),
      distanceM: dists[b] - dists[a],
      waySegments: waySegments.length > 0 ? waySegments : undefined,
    });
  }
  return { legs, junctions: cuts.map(i => [coords[i][0], coords[i][1]] as LonLat) };
}

export function straightLeg(from: LonLat, to: LonLat): RouteLeg {
  return {
    coords: [
      [from[0], from[1], 0],
      [to[0], to[1], 0],
    ],
    distanceM: haversineM(from, to),
  };
}

function routeUrl(lonlats: string, profile: string): string {
  return `${BROUTER_URL}?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`;
}

async function resolveProfile(): Promise<string> {
  if (activePreset === 'balanced') return DEFAULT_PROFILE;
  if (customProfileId) return customProfileId;
  customProfileUpload ??= uploadPresetProfile(activePreset);
  try {
    customProfileId = await customProfileUpload;
    return customProfileId;
  } catch {
    // upload failed: route anyway, with the standard profile
    customProfileUpload = null;
    return DEFAULT_PROFILE;
  }
}

async function uploadPresetProfile(preset: RoutingPreset): Promise<string> {
  let body = profileTemplate;
  for (const [pattern, replacement] of PRESET_PATCHES[preset]) {
    if (!pattern.test(body)) throw new Error(`brouter profile: ${preset} patch no longer matches the template`);
    body = body.replace(pattern, replacement);
  }
  const res = await fetchWithTimeout(`${BROUTER_URL}/profile`, { method: 'POST', body });
  if (!res.ok) throw new Error(`brouter profile ${res.status}`);
  const data = await res.json();
  if (!data.profileid) throw new Error('brouter profile: empty response');
  return data.profileid as string;
}
