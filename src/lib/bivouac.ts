/**
 * How good a spot is for a bivouac, scored from the terrain and what OpenStreetMap knows.
 *
 * The search refines a plan rather than replacing it: the hiker cuts the days first, dropping
 * rough camps on the trace by kilometres, climb and interest, and each of those camps then gets
 * its own suggestions within walking reach. Picking one moves that camp, so the shape of the
 * trek is never rearranged by the scoring.
 *
 * The criteria are the ones a hiker actually weighs at the end of a stage, in that order:
 *
 * - **flat** (25%): a tent needs ground under ~5°, and nothing else matters on a 25° slope;
 * - **water** (20%): not the straight-line distance but the *walking* time, so a spring 200 m
 *   away and 80 m below scores worse than one 400 m away on the flat (same Tobler curve the
 *   duration estimates use);
 * - **on plan** (20%): how far it shifts the day, because a perfect meadow an hour past the
 *   planned stop is somebody else's stage;
 * - **discreet** (15%): metres to the nearest road or building, which is both courtesy and,
 *   in most French parks, the difference between tolerated and forbidden;
 * - **sheltered** (10%): how much of the surrounding ring rises above the spot, so a dip or a
 *   shoulder beats an exposed crest when the wind gets up;
 * - **view** (10%): how far the ground falls away on the open sides.
 *
 * Shelter and view pull against each other on purpose: a spot cannot max both, and the two
 * weights let a hiker read the trade-off in the sub-scores rather than trust one number.
 *
 * Some spots are refused outright rather than scored low: ground too steep to pitch on, the
 * inside of a lake or a wide river, or a road or building close enough that sleeping there is
 * neither legal nor pleasant.
 */

import { sampleElevations } from './demElevation';
import { cumulativeDistancesM, haversineM, type LonLat, type LonLatEle } from './geo';
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

/** how far along the route a camp may reasonably slide: about twenty minutes of walking */
export const SHIFT_RADIUS_M = 1200;
/** closer than this to the planned stop, the night does not really move */
export const ON_PLAN_M = 50;

const WEIGHTS = { flatness: 0.25, water: 0.2, onPlan: 0.2, quiet: 0.15, shelter: 0.1, view: 0.1 };

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
  /** metres along the route between this spot and the camp it would replace */
  shiftM: number;
  /** the spot falls inside a lake or a wide river: flat, quiet, by the water, and unpitchable */
  inWater: boolean;
}

export interface BivouacScore {
  /** 0 to 100, or 0 with a veto */
  total: number;
  flatness: number;
  water: number;
  onPlan: number;
  quiet: number;
  shelter: number;
  view: number;
  slopeDeg: number;
  veto: 'slope' | 'water' | 'intrusion' | null;
}

export interface BivouacSpot extends BivouacScore {
  point: LonLat;
  elevation: number;
  waterMinutes: number | null;
  /** metres this suggestion would move the camp along the route */
  shiftM: number;
  /** the camp it was computed for, so a click never has to guess which night it refines */
  campId: string;
  campName: string;
}

/** the suggestions for one rough camp, best first */
export interface BivouacGroup {
  campId: string;
  campName: string;
  /** the day this camp closes, 1-based */
  day: number;
  spots: BivouacSpot[];
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
    onPlan: ramp(context.shiftM, 0, SHIFT_RADIUS_M, true),
    // nothing found in range means the query came back empty, which is the quiet we want
    quiet: context.intrusionM === null ? 1 : ramp(context.intrusionM, MIN_INTRUSION_M, QUIET_M, false),
    shelter: shelterScore(probe),
    view: viewScore(probe),
  };
  const veto = vetoFor(slopeDeg, context);
  const total = veto
    ? 0
    : Math.round(
        100 *
          (parts.flatness * WEIGHTS.flatness +
            parts.water * WEIGHTS.water +
            parts.onPlan * WEIGHTS.onPlan +
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

/** ray casting on lon/lat: over a lake the projection error is far below a tent's width */
export function isInsideRing(point: LonLat, ring: LonLat[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] && point[0] < xi + ((xj - xi) * (point[1] - yi)) / (yj - yi)) {
      inside = !inside;
    }
  }
  return inside;
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

/** what makes a spot unusable rather than merely mediocre */
function vetoFor(slopeDeg: number, context: BivouacContext): BivouacScore['veto'] {
  if (slopeDeg > MAX_SLOPE_DEG) return 'slope';
  if (context.inWater) return 'water';
  if (context.intrusionM !== null && context.intrusionM < MIN_INTRUSION_M) return 'intrusion';
  return null;
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
const STEP_M = 200;
/** and this far off it, on both sides: a bivouac is rarely on the path itself */
const OFFSETS_M = [0, 80, 160];
/** two suggestions closer than this are the same place */
const MERGE_M = 300;
/** the water and intrusion queries reach this far around the route's box, in degrees */
const CONTEXT_MARGIN_DEG = 0.02;
/** water outlines fetched around a route: enough for a valley, small enough to stay quick */
const WATER_AREA_LIMIT = 300;
/** shore points kept per outline, so a long reservoir does not flood the DEM batch */
const SHORE_SAMPLES = 12;
/** below this a suggestion is not worth a row, even as the best of a bad zone */
const MIN_TOTAL = 35;

/** a rough camp the hiker dropped while cutting the days */
export interface PlannedCamp {
  id: string;
  name: string;
  /** where it sits along the route, in metres */
  distanceM: number;
}

export interface BivouacSearch {
  groups: BivouacGroup[];
  /** true when the terrain was read but the map data could not be fetched */
  terrainOnly: boolean;
}

/**
 * Looks for better spots around the camps already planned.
 *
 * Each camp is searched on its own, within walking reach along the route, so the answer is a
 * shortlist per night instead of a pile of places belonging to no particular day. Water and
 * intrusions come from two Overpass queries over the route's box; if Overpass refuses, the
 * search still returns terrain scores and says so rather than pretending the area has no water.
 *
 * Args:
 *   coords: the route.
 *   camps: the rough camps to refine, in route order.
 *   profile: the hiker, for the walk to water.
 *   perCamp: how many suggestions to keep for each.
 */
export async function findBivouacSpots(
  coords: LonLatEle[],
  camps: PlannedCamp[],
  profile?: HikerProfile,
  perCamp = 3,
): Promise<BivouacSearch> {
  if (coords.length < 2 || camps.length === 0) return { groups: [], terrainOnly: false };
  const dists = cumulativeDistancesM(coords);
  const candidates = camps.map(camp => candidatesAround(coords, dists, camp));
  const flat = candidates.flat();
  const [context, probes] = await Promise.all([
    fetchContext(coords).catch(() => null),
    probeTerrain(flat.map(c => c.point)),
  ]);

  let cursor = 0;
  const groups = camps.map((camp, campIndex) => {
    const scored = candidates[campIndex].map(candidate => {
      const probe = probes[cursor++];
      const here: LonLatEle = [candidate.point[0], candidate.point[1], probe.elevation];
      const minutes = context ? waterMinutes(here, context.waters, profile) : null;
      const score = scoreBivouac(probe, {
        waterMinutes: minutes,
        intrusionM: context ? nearestDistanceM(candidate.point, context.intrusions) : null,
        shiftM: candidate.shiftM,
        inWater: context ? context.surfaces.some(ring => isInsideRing(candidate.point, ring)) : false,
      });
      return {
        ...score,
        point: candidate.point,
        elevation: probe.elevation,
        waterMinutes: minutes,
        shiftM: candidate.shiftM,
        campId: camp.id,
        campName: camp.name,
      };
    });

    const spots: BivouacSpot[] = [];
    for (const spot of scored.sort((a, b) => b.total - a.total)) {
      if (spot.total < MIN_TOTAL) break;
      if (spots.some(other => haversineM(other.point, spot.point) < MERGE_M)) continue;
      spots.push(spot);
      if (spots.length === perCamp) break;
    }
    return { campId: camp.id, campName: camp.name, day: campIndex + 1, spots };
  });

  return { groups: groups.filter(group => group.spots.length > 0), terrainOnly: context === null };
}

interface Candidate {
  point: LonLat;
  shiftM: number;
}

/**
 * The places a camp could reasonably slide to, on the path and just off it.
 *
 * Sampled every STEP_M of *walking*, not at the geometry's vertices: a manual leg or a coarse
 * imported GPX can hold a single straight line over kilometres, and a camp there deserves more
 * than the one candidate its endpoints would offer.
 */
function candidatesAround(coords: LonLatEle[], dists: number[], camp: PlannedCamp): Candidate[] {
  const out: Candidate[] = [];
  const total = dists[dists.length - 1];
  const from = Math.max(0, camp.distanceM - SHIFT_RADIUS_M);
  const to = Math.min(total, camp.distanceM + SHIFT_RADIUS_M);
  let segment = 1;
  for (let at = from; at <= to; at += STEP_M) {
    while (segment < coords.length - 1 && dists[segment] < at) segment++;
    const [pLon, pLat] = coords[segment - 1];
    const [nLon, nLat] = coords[segment];
    const span = dists[segment] - dists[segment - 1];
    const t = span > 0 ? (at - dists[segment - 1]) / span : 0;
    const here: LonLat = [pLon + t * (nLon - pLon), pLat + t * (nLat - pLat)];
    // perpendicular to the local heading, so the offsets leave the path instead of following it
    const heading = Math.atan2(nLat - pLat, (nLon - pLon) * Math.cos((here[1] * Math.PI) / 180));
    const shiftM = Math.abs(at - camp.distanceM);
    for (const offset of OFFSETS_M) {
      for (const side of offset === 0 ? [1] : [1, -1]) {
        out.push({ point: movedBy(here, heading + (side * Math.PI) / 2, offset), shiftM });
      }
    }
  }
  return out;
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
  /** the outlines of lakes and wide rivers: water to draw from, ground to stay off */
  surfaces: LonLat[][];
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

  type Element = {
    lon?: number;
    lat?: number;
    center?: { lon: number; lat: number };
    geometry?: { lon: number; lat: number }[];
  };
  // lakes come back as outlines rather than centres: a centroid says neither where the shore is
  // nor that the candidate is floating in the middle of it
  const [waterEls, intrusionEls] = await Promise.all([
    overpassQuery<Element>(
      `[out:json][timeout:25];(` +
        `node["natural"="spring"](${bbox});` +
        `node["amenity"="drinking_water"](${bbox});` +
        `way["waterway"~"^(stream|river)$"](${bbox});` +
        `);out center 800;` +
        `way["natural"="water"](${bbox});out geom ${WATER_AREA_LIMIT};`,
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
  const surfaces = waterEls
    .filter(el => (el.geometry?.length ?? 0) >= 4)
    .map(el => (el.geometry as { lon: number; lat: number }[]).map(g => [g.lon, g.lat] as LonLat));
  // a shore is reached at its nearest point, so each outline contributes a few of its own, thinned
  // to keep the DEM batch that prices the walk to water in proportion
  const shorePoints = surfaces.flatMap(ring => everyNth(ring, Math.ceil(ring.length / SHORE_SAMPLES)));
  const waterPoints = [...waterEls.map(toPoint).filter((p): p is LonLat => p !== null), ...shorePoints];
  // the walk to water needs its altitude: read it from the same DEM as the terrain
  const waterElevations = waterPoints.length > 0 ? await sampleElevations(waterPoints) : [];
  return {
    waters: waterPoints.map((p, i) => [p[0], p[1], waterElevations[i] ?? 0] as LonLatEle),
    intrusions: intrusionEls.map(toPoint).filter((p): p is LonLat => p !== null),
    surfaces,
  };
}

function everyNth<T>(items: T[], step: number): T[] {
  return items.filter((_, i) => i % Math.max(1, step) === 0);
}

/** a point `distanceM` away along `heading` (radians, 0 = north) */
function movedBy([lon, lat]: LonLat, heading: number, distanceM: number): LonLat {
  const dLat = (distanceM * Math.cos(heading)) / 111_320;
  const dLon = (distanceM * Math.sin(heading)) / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lon + dLon, lat + dLat];
}
