/**
 * How good a spot is for a bivouac, scored from the terrain and what OpenStreetMap knows.
 *
 * The criteria are the ones a hiker actually weighs at the end of a stage, in that order:
 *
 * - **flat** (30%): a tent needs ground under ~5°, and nothing else matters on a 25° slope;
 * - **water** (25%): not the straight-line distance but the *walking* time, so a spring 200 m
 *   away and 80 m below scores worse than one 400 m away on the flat (same Tobler curve the
 *   duration estimates use);
 * - **discreet** (15%): metres to the nearest road or building, which is both courtesy and,
 *   in most French parks, the difference between tolerated and forbidden;
 * - **sheltered** (15%): how much of the surrounding ring rises above the spot, so a dip or a
 *   shoulder beats an exposed crest when the wind gets up;
 * - **view** (15%): how far the ground falls away on the open sides.
 *
 * Shelter and view pull against each other on purpose: a spot cannot max both, and the two
 * weights let a hiker read the trade-off in the sub-scores rather than trust one number.
 *
 * Some spots are refused outright rather than scored low: ground too steep to pitch on, or a
 * road or building close enough that sleeping there is neither legal nor pleasant.
 */

import { sampleElevations } from './demElevation';
import { haversineM, type LonLat, type LonLatEle } from './geo';
import { durationH, type HikerProfile } from './hikingTime';
import { overpassQuery } from './overpass';

/** how far from the spot the terrain is probed for shelter and view */
export const RING_RADIUS_M = 120;
/** samples around that ring, every 30 degrees */
export const RING_SAMPLES = 12;
/** the arm of the cross used for the local slope: shorter than a tent, longer than DEM noise */
export const SLOPE_STEP_M = 25;

/** ground steeper than this cannot hold a tent, whatever else the spot offers */
const MAX_SLOPE_DEG = 20;
/** closer than this to a road or a house, a bivouac is neither legal nor restful */
const MIN_INTRUSION_M = 25;
/** flat enough that nobody notices the slope */
const FLAT_DEG = 3;
/** water within this walk is "at the camp" */
const WATER_NEAR_MIN = 5;
/** past this walk, fetching water is an expedition */
const WATER_FAR_MIN = 30;
/** far enough from a road to be out of sight and out of earshot */
const QUIET_M = 300;
/** a ring rising this much above the spot counts as full shelter */
const SHELTER_REF_M = 25;
/** a drop this deep on the open sides counts as a full view */
const VIEW_REF_M = 120;
/** the share of the ring that makes the view: a vista is a direction, not an average */
const VIEW_DIRECTIONS = 4;

const WEIGHTS = { flatness: 0.3, water: 0.25, quiet: 0.15, shelter: 0.15, view: 0.15 };

export interface BivouacProbe {
  elevation: number;
  /** the four cross neighbours at SLOPE_STEP_M: north, east, south, west */
  cross: [number, number, number, number];
  /** RING_SAMPLES elevations at RING_RADIUS_M, clockwise from north */
  ring: number[];
}

export interface BivouacContext {
  /** minutes of walking to the nearest usable water, null when none was found in range */
  waterMinutes: number | null;
  /** metres to the nearest road or building, null when none was found in range */
  intrusionM: number | null;
}

export interface BivouacScore {
  /** 0 to 100, or 0 with a veto */
  total: number;
  flatness: number;
  water: number;
  quiet: number;
  shelter: number;
  view: number;
  slopeDeg: number;
  veto: 'slope' | 'intrusion' | null;
}

export interface BivouacSpot extends BivouacScore {
  point: LonLat;
  elevation: number;
  waterMinutes: number | null;
}

/**
 * Scores one candidate spot.
 *
 * Args:
 *   probe: the terrain around it.
 *   context: what the map knows nearby.
 */
export function scoreBivouac(probe: BivouacProbe, context: BivouacContext): BivouacScore {
  const slopeDeg = slopeFromCross(probe.cross);
  const parts = {
    flatness: ramp(slopeDeg, FLAT_DEG, 15, true),
    water: context.waterMinutes === null ? 0 : ramp(context.waterMinutes, WATER_NEAR_MIN, WATER_FAR_MIN, true),
    // nothing found in range means the query came back empty, which is the quiet we want
    quiet: context.intrusionM === null ? 1 : ramp(context.intrusionM, MIN_INTRUSION_M, QUIET_M, false),
    shelter: shelterScore(probe),
    view: viewScore(probe),
  };
  const veto = slopeDeg > MAX_SLOPE_DEG ? 'slope' : isTooClose(context.intrusionM) ? 'intrusion' : null;
  const total = veto
    ? 0
    : Math.round(
        100 *
          (parts.flatness * WEIGHTS.flatness +
            parts.water * WEIGHTS.water +
            parts.quiet * WEIGHTS.quiet +
            parts.shelter * WEIGHTS.shelter +
            parts.view * WEIGHTS.view),
      );
  return { total, ...parts, slopeDeg, veto };
}

/**
 * Walking minutes from a spot to the closest of the given water points.
 *
 * A straight line with its real elevation change, priced on the hiking curve: an honest
 * approximation, not a routed path, and one that already tells a spring below a cliff from a
 * spring across a meadow.
 *
 * Args:
 *   from: the candidate spot, with its elevation.
 *   waters: known water points with elevations.
 *   profile: the hiker, so a heavy pack lengthens the walk.
 */
export function waterMinutes(from: LonLatEle, waters: LonLatEle[], profile?: HikerProfile): number | null {
  let best: number | null = null;
  for (const water of waters) {
    const minutes = durationH([from, water], profile) * 60;
    if (best === null || minutes < best) best = minutes;
  }
  return best;
}

/** metres to the closest intrusion, or null when none is in the list */
export function nearestDistanceM(from: LonLat, points: LonLat[]): number | null {
  let best: number | null = null;
  for (const point of points) {
    const d = haversineM(from, point);
    if (best === null || d < best) best = d;
  }
  return best;
}

/** the steepest gradient of the cross, in degrees */
function slopeFromCross([north, east, south, west]: [number, number, number, number]): number {
  const dy = (north - south) / (2 * SLOPE_STEP_M);
  const dx = (east - west) / (2 * SLOPE_STEP_M);
  return (Math.atan(Math.hypot(dx, dy)) * 180) / Math.PI;
}

/** how much of the ring stands above the spot, capped per direction */
function shelterScore(probe: BivouacProbe): number {
  if (probe.ring.length === 0) return 0;
  const sum = probe.ring.reduce((acc, elev) => acc + clamp01((elev - probe.elevation) / SHELTER_REF_M), 0);
  return sum / probe.ring.length;
}

/** the deepest drops around the spot: a view is a handful of open directions */
function viewScore(probe: BivouacProbe): number {
  if (probe.ring.length === 0) return 0;
  const drops = probe.ring.map(elev => clamp01((probe.elevation - elev) / VIEW_REF_M)).sort((a, b) => b - a);
  const open = drops.slice(0, Math.min(VIEW_DIRECTIONS, drops.length));
  return open.reduce((a, b) => a + b, 0) / open.length;
}

function isTooClose(intrusionM: number | null): boolean {
  return intrusionM !== null && intrusionM < MIN_INTRUSION_M;
}

/** 1 at `good`, 0 at `bad`, linear in between; `descending` when a smaller value is better */
function ramp(value: number, good: number, bad: number, descending: boolean): number {
  const t = descending ? (bad - value) / (bad - good) : (value - good) / (bad - good);
  return clamp01(t);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** candidates are taken this often along the route */
const STEP_M = 250;
/** and this far off it, on both sides: a bivouac is rarely on the path itself */
const OFFSETS_M = [0, 80, 160];
/** two suggestions closer than this are the same place */
const MERGE_M = 350;
/** the water and intrusion queries reach this far around the route's box, in degrees */
const CONTEXT_MARGIN_DEG = 0.02;
/** a spot with less than this is not worth suggesting */
const MIN_TOTAL = 45;

export interface BivouacSearch {
  spots: BivouacSpot[];
  /** true when the terrain was read but the map data could not be fetched */
  terrainOnly: boolean;
}

/**
 * Looks for the best bivouac spots along a route.
 *
 * Candidates are taken every few hundred metres, on the path and slightly off it, and each is
 * probed against the DEM already cached for the relief. Water and intrusions come from two
 * Overpass queries over the route's box; if Overpass refuses, the search still returns terrain
 * scores and says so rather than pretending the area has no water.
 *
 * Args:
 *   coords: the route.
 *   profile: the hiker, for the walk to water.
 *   limit: how many spots to keep.
 */
export async function findBivouacSpots(coords: LonLatEle[], profile?: HikerProfile, limit = 6): Promise<BivouacSearch> {
  if (coords.length < 2) return { spots: [], terrainOnly: false };
  const candidates = candidatePoints(coords);
  const [context, elevations] = await Promise.all([fetchContext(coords).catch(() => null), probeTerrain(candidates)]);

  const scored: BivouacSpot[] = candidates.map((point, i) => {
    const probe = elevations[i];
    const here: LonLatEle = [point[0], point[1], probe.elevation];
    const minutes = context ? waterMinutes(here, context.waters, profile) : null;
    const score = scoreBivouac(probe, {
      waterMinutes: minutes,
      intrusionM: context ? nearestDistanceM(point, context.intrusions) : null,
    });
    return { ...score, point, elevation: probe.elevation, waterMinutes: minutes };
  });

  const kept: BivouacSpot[] = [];
  for (const spot of scored.sort((a, b) => b.total - a.total)) {
    if (spot.total < MIN_TOTAL) break;
    if (kept.some(other => haversineM(other.point, spot.point) < MERGE_M)) continue;
    kept.push(spot);
    if (kept.length === limit) break;
  }
  return { spots: kept, terrainOnly: context === null };
}

/** points along the route and just off it, without duplicating the same place twice */
function candidatePoints(coords: LonLatEle[]): LonLat[] {
  const points: LonLat[] = [];
  let sinceLast = STEP_M;
  for (let i = 1; i < coords.length; i++) {
    sinceLast += haversineM([coords[i - 1][0], coords[i - 1][1]], [coords[i][0], coords[i][1]]);
    if (sinceLast < STEP_M) continue;
    sinceLast = 0;
    const [lon, lat] = coords[i];
    // perpendicular to the local heading, so the offsets leave the path instead of following it
    const [pLon, pLat] = coords[i - 1];
    const heading = Math.atan2(lat - pLat, (lon - pLon) * Math.cos((lat * Math.PI) / 180));
    for (const offset of OFFSETS_M) {
      for (const side of offset === 0 ? [1] : [1, -1]) {
        points.push(movedBy([lon, lat], heading + (side * Math.PI) / 2, offset));
      }
    }
  }
  return points;
}

/** the DEM cross and ring around every candidate, in one batch */
async function probeTerrain(points: LonLat[]): Promise<BivouacProbe[]> {
  const ringAngles = Array.from({ length: RING_SAMPLES }, (_, i) => (i * 2 * Math.PI) / RING_SAMPLES);
  const queries: LonLat[] = [];
  for (const point of points) {
    queries.push(point);
    for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
      queries.push(movedBy(point, angle, SLOPE_STEP_M));
    }
    for (const angle of ringAngles) queries.push(movedBy(point, angle, RING_RADIUS_M));
  }
  const elevations = await sampleElevations(queries);
  const perPoint = 1 + 4 + RING_SAMPLES;
  return points.map((_, i) => {
    const base = i * perPoint;
    return {
      elevation: elevations[base],
      cross: [elevations[base + 1], elevations[base + 2], elevations[base + 3], elevations[base + 4]] as [
        number,
        number,
        number,
        number,
      ],
      ring: elevations.slice(base + 5, base + perPoint),
    };
  });
}

interface BivouacContextData {
  waters: LonLatEle[];
  intrusions: LonLat[];
}

/** water and man-made things around the route, from OpenStreetMap */
async function fetchContext(coords: LonLatEle[]): Promise<BivouacContextData> {
  const lons = coords.map(c => c[0]);
  const lats = coords.map(c => c[1]);
  const bbox = [
    Math.min(...lats) - CONTEXT_MARGIN_DEG,
    Math.min(...lons) - CONTEXT_MARGIN_DEG,
    Math.max(...lats) + CONTEXT_MARGIN_DEG,
    Math.max(...lons) + CONTEXT_MARGIN_DEG,
  ].join(',');

  type Element = { lon?: number; lat?: number; center?: { lon: number; lat: number } };
  const [waterEls, intrusionEls] = await Promise.all([
    overpassQuery<Element>(
      `[out:json][timeout:25];(` +
        `node["natural"="spring"](${bbox});` +
        `node["amenity"="drinking_water"](${bbox});` +
        `way["natural"="water"](${bbox});` +
        `way["waterway"~"^(stream|river)$"](${bbox});` +
        `);out center 800;`,
    ),
    overpassQuery<Element>(
      `[out:json][timeout:25];(` +
        `way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)$"](${bbox});` +
        `way["building"](${bbox});` +
        `);out center 1200;`,
    ),
  ]);

  const toPoint = (el: Element): LonLat | null => {
    const lon = el.lon ?? el.center?.lon;
    const lat = el.lat ?? el.center?.lat;
    return lon !== undefined && lat !== undefined ? [lon, lat] : null;
  };
  const waterPoints = waterEls.map(toPoint).filter((p): p is LonLat => p !== null);
  // the walk to water needs its altitude: read it from the same DEM as the terrain
  const waterElevations = waterPoints.length > 0 ? await sampleElevations(waterPoints) : [];
  return {
    waters: waterPoints.map((p, i) => [p[0], p[1], waterElevations[i] ?? 0] as LonLatEle),
    intrusions: intrusionEls.map(toPoint).filter((p): p is LonLat => p !== null),
  };
}

/** a point `distanceM` away along `heading` (radians, 0 = north) */
function movedBy([lon, lat]: LonLat, heading: number, distanceM: number): LonLat {
  const dLat = (distanceM * Math.cos(heading)) / 111_320;
  const dLon = (distanceM * Math.sin(heading)) / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lon + dLon, lat + dLat];
}
