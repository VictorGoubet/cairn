import profileTemplate from '../config/hiking-mountain.brf?raw';
import { cumulativeDistancesM, elevationStats, haversineM, hikingDurationH, type LonLat, type LonLatEle } from './geo';
import { fetchWithTimeout } from './http';
import { parseWaySegments, type WaySegment } from './waytypes';

const BROUTER_URL = 'https://brouter.de/brouter';
const DEFAULT_PROFILE = 'hiking-mountain';

/**
 * Variants of the bundled profile, each a documented switch of the template.
 *
 * A preset can race several of them: "fastest" is the honest example, since no single set of
 * BRouter cost weights minimizes the duration this app displays (its elevation costs are
 * filtered and buffered, ours is a raw SuisseMobile sum). Racing distance-first against
 * climb-averse and keeping the quicker answer is coherent by construction.
 */
const VARIANT_PATCHES: Record<Variant, [RegExp, string][]> = {
  balanced: [],
  avoid_roads: [[/^assign {3}path_preference {10}0\.0/m, 'assign   path_preference          20.0']],
  easy_up: [[/^assign {3}consider_elevation {5}= false/m, 'assign   consider_elevation     = true']],
  // the template's own switch: every walkable way costs its length, roads included; foot
  // access keeps its veto, so a motorway stays at 100000 whatever the distance saved
  shortest: [[/^assign {3}shortest_way {13}0/m, 'assign   shortest_way             1']],
  // climb-averse at the rates of our own clock: 4.2 km/h flat, 400 m/h up, 800 m/h down, so a
  // metre of ascent is worth ~10 m of flat and a metre of descent ~5
  climb_averse: [
    [/^assign {3}consider_elevation {5}= false/m, 'assign   consider_elevation     = true'],
    [/^assign {3}uphillcostvalue {6}7/m, 'assign   uphillcostvalue      10'],
    [/^assign {3}downhillcostvalue {4}7/m, 'assign   downhillcostvalue    5'],
    [/^assign {3}hiking_routes_preference 0\.20/m, 'assign   hiking_routes_preference 0.00'],
  ],
};

type Variant = 'balanced' | 'avoid_roads' | 'easy_up' | 'shortest' | 'climb_averse';

const PRESET_CANDIDATES: Record<RoutingPreset, Variant[]> = {
  balanced: ['balanced'],
  shortest: ['shortest'],
  fastest: ['shortest', 'climb_averse'],
  avoid_roads: ['avoid_roads'],
  easy_up: ['easy_up'],
};

export type RoutingPreset = 'balanced' | 'shortest' | 'fastest' | 'avoid_roads' | 'easy_up';

export interface RouteLeg {
  coords: LonLatEle[];
  distanceM: number;
  /** way analysis; missing for manual legs or imported ones without a match */
  waySegments?: WaySegment[];
}

let activePreset: RoutingPreset = 'balanced';
// ids of the custom profiles uploaded to brouter.de, one per variant; an entry is dropped when
// the server expires it, and the upload is shared so a burst of legs uploads once
const profileUploads = new Map<Variant, Promise<string>>();

/**
 * Changes the preset used by the next routing calls.
 *
 * Args:
 *   preset: balanced (standard profile), avoid roads, or limit elevation gain.
 */
export function setRoutingPreset(preset: RoutingPreset): void {
  activePreset = preset;
}

/**
 * Routes a chain of points in a single request (easy on the volunteer-run server).
 *
 * Args:
 *   points: at least two points; the intermediate ones are via points snapped to the network.
 */
export async function computeRoute(points: LonLat[]): Promise<RouteLeg> {
  const candidates = PRESET_CANDIDATES[activePreset];
  const answers = await Promise.allSettled(candidates.map(variant => requestRoute(points, variant)));
  const legs = answers.filter(a => a.status === 'fulfilled').map(a => a.value);
  if (legs.length === 0) throw (answers[0] as PromiseRejectedResult).reason;
  // one candidate: nothing to choose. Several: the one our own clock calls quicker, which is
  // the promise the "fastest" label makes to the hiker
  return legs.reduce((best, leg) => (estimatedHours(leg) < estimatedHours(best) ? leg : best));
}

function estimatedHours(leg: RouteLeg): number {
  const { gainM, lossM } = elevationStats(leg.coords);
  return hikingDurationH(leg.distanceM, gainM, lossM);
}

async function requestRoute(points: LonLat[], variant: Variant): Promise<RouteLeg> {
  const lonlats = points.map(p => `${p[0]},${p[1]}`).join('|');
  const profile = await resolveProfile(variant);
  let res = await fetchWithTimeout(routeUrl(lonlats, profile));
  // a custom profile expired server-side is re-uploaded once before giving up
  if (!res.ok && profile !== DEFAULT_PROFILE) {
    profileUploads.delete(variant);
    res = await fetchWithTimeout(routeUrl(lonlats, await resolveProfile(variant)));
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

async function resolveProfile(variant: Variant): Promise<string> {
  if (variant === 'balanced') return DEFAULT_PROFILE;
  const pending = profileUploads.get(variant) ?? uploadVariantProfile(variant);
  profileUploads.set(variant, pending);
  try {
    return await pending;
  } catch {
    // upload failed: route anyway, with the standard profile
    profileUploads.delete(variant);
    return DEFAULT_PROFILE;
  }
}

async function uploadVariantProfile(variant: Variant): Promise<string> {
  let body = profileTemplate;
  for (const [pattern, replacement] of VARIANT_PATCHES[variant]) {
    if (!pattern.test(body)) throw new Error(`brouter profile: ${variant} patch no longer matches the template`);
    body = body.replace(pattern, replacement);
  }
  const res = await fetchWithTimeout(`${BROUTER_URL}/profile`, { method: 'POST', body });
  if (!res.ok) throw new Error(`brouter profile ${res.status}`);
  const data = await res.json();
  if (!data.profileid) throw new Error('brouter profile: empty response');
  return data.profileid as string;
}
