/**
 * Marked hiking routes around the viewport, from OpenStreetMap through the Overpass API.
 *
 * Two queries on purpose. The list asks only for relation tags (cheap, one request per grid
 * cell, memoized for the session), and the geometry of a single route is fetched when the user
 * loads it: asking for the geometry of everything in view would download whole GR traversals
 * just to draw a list.
 */

import { sampleElevations } from './demElevation';
import { haversineM, type LonLat, type LonLatEle } from './geo';
import { overpassQuery } from './overpass';
import { type Cell, cachedFetch, cellBounds, cellsInBounds, type ViewBounds } from './tileGrid';

/** below this zoom the area covers too many routes to mean anything */
export const NEARBY_HIKES_MIN_ZOOM = 11;

// z11 cells (~15 km per side), the grid the trail overlay already uses: wider cells were
// cheaper to cache but listed routes tens of kilometres away, which is not "around here"
const CELL_ZOOM = 11;
const MAX_CELLS_PER_VIEW = 6;
const CACHE_MAX_CELLS = 64;
// generous, so Overpass never truncates the answer at an arbitrary cut: relevance is decided
// here, after sorting, not by whichever relations the server happened to emit first
const MAX_ROUTES_PER_CELL = 200;
/** a loaded route is clipped to this much around the map center: a GR runs for hundreds of km */
const MAX_LOADED_M = 45_000;
/** two way ends closer than this belong to the same continuous itinerary */
const JOIN_TOLERANCE_M = 60;
/** members carrying these roles are variants, not the route itself */
const SIDE_ROLES = /alternative|variant|excursion|approach|connection|access|link/i;
/**
 * Local routes first. The convention in trail catalogues is the opposite, international down to
 * local, but around any alpine village that buries the day loops under every stage of the Via
 * Alpina; what is nearby and walkable in a day deserves the top of the list.
 */
const NETWORK_RANK: Record<string, number> = { lwn: 0, rwn: 1, nwn: 2, iwn: 3 };

export interface NearbyHike {
  id: number;
  name: string;
  /** trail code, "GR58" or "PR12", empty when the relation has none */
  ref: string;
  /** OSM network: iwn, nwn, rwn, lwn */
  network: string;
  /** length declared by the relation, in km, when it carries the tag */
  declaredKm: number | null;
}

const cellCache = new Map<string, Promise<NearbyHike[]>>();

/**
 * Marked hiking routes whose path enters the given area.
 *
 * Args:
 *   bounds: viewport extent in degrees.
 *
 * Returns:
 *   Named routes, deduplicated and sorted by locality then length, or an empty list when the
 *   area is too wide.
 */
export async function fetchNearbyHikes(bounds: ViewBounds): Promise<NearbyHike[]> {
  const cells = cellsInBounds(bounds, CELL_ZOOM);
  if (cells.length === 0 || cells.length > MAX_CELLS_PER_VIEW) return [];
  // a cell that fails only silences its own area: the view keeps whatever the others found,
  // and only a view where every cell failed surfaces as an error
  const results = await Promise.allSettled(
    cells.map(cell => cachedFetch(cellCache, `${cell.x}/${cell.y}`, CACHE_MAX_CELLS, () => queryHikes(cell))),
  );
  const found = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  if (found.length === 0 && results.length > 0) throw new Error('overpass unavailable');
  const byId = new Map<number, NearbyHike>();
  for (const hike of found.flat()) byId.set(hike.id, hike);
  return [...byId.values()].sort(
    (a, b) =>
      (NETWORK_RANK[a.network] ?? 9) - (NETWORK_RANK[b.network] ?? 9) ||
      (a.declaredKm ?? Number.POSITIVE_INFINITY) - (b.declaredKm ?? Number.POSITIVE_INFINITY) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * Full track of one route, ready to become an itinerary.
 *
 * Args:
 *   id: OSM relation id.
 *   center: map center, the anchor a long route is clipped around.
 *
 * Returns:
 *   The longest continuous stretch of the route, with elevations sampled from the DEM.
 */
export async function fetchHikeTrack(id: number, center: LonLat): Promise<LonLatEle[]> {
  const elements = await overpassQuery<{ type: string; members?: RelationMember[] }>(
    `[out:json][timeout:30];rel(${id});out geom;`,
  );
  const relation = elements.find(el => el.type === 'relation');
  const ways: LonLat[][] = [];
  for (const member of relation?.members ?? []) {
    if (member.type !== 'way' || !member.geometry || SIDE_ROLES.test(member.role ?? '')) continue;
    const way: LonLat[] = [];
    for (const point of member.geometry) {
      if (Number.isFinite(point.lon) && Number.isFinite(point.lat))
        way.push([point.lon as number, point.lat as number]);
    }
    if (way.length >= 2) ways.push(way);
  }
  const stitched = clipAround(stitchWays(ways), center, MAX_LOADED_M);
  if (stitched.length < 2) throw new Error('route has no usable geometry');
  // OSM carries no elevation: the DEM fills it in, the same source the planner uses off-trail
  const elevations = await sampleElevations(stitched);
  return stitched.map(([lon, lat], i) => [lon, lat, elevations[i] ?? 0]);
}

/**
 * Chains the ways of a relation into the longest continuous itinerary.
 *
 * A hiking relation is an unordered bag of ways, some reversed, some belonging to a loop or a
 * spur. Greedy chaining from the longest way and keeping the longest resulting chain gives a
 * walkable line, where honoring every member would give a discontinuous mess.
 *
 * Args:
 *   ways: member geometries.
 *   toleranceM: how far apart two ends can be and still count as joined.
 */
export function stitchWays(ways: LonLat[][], toleranceM = JOIN_TOLERANCE_M): LonLat[] {
  const remaining = [...ways].sort((a, b) => lineLengthM(b) - lineLengthM(a));
  let best: LonLat[] = [];
  while (remaining.length > 0) {
    let chain = remaining.shift() as LonLat[];
    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < remaining.length; i++) {
        const way = remaining[i];
        const joined = join(chain, way, toleranceM);
        if (!joined) continue;
        chain = joined;
        remaining.splice(i, 1);
        extended = true;
        break;
      }
    }
    if (lineLengthM(chain) > lineLengthM(best)) best = chain;
  }
  return best;
}

/**
 * Keeps at most `maxM` of a track, centered on the point closest to `center`.
 *
 * Loading a whole national traversal as an editable itinerary helps nobody; what the hiker
 * clicked on is the part in front of them.
 *
 * Args:
 *   coords: full track.
 *   center: map center.
 *   maxM: length budget.
 */
export function clipAround(coords: LonLat[], center: LonLat, maxM: number): LonLat[] {
  if (coords.length < 2 || lineLengthM(coords) <= maxM) return coords;
  let pivot = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  coords.forEach((c, i) => {
    const d = haversineM(center, c);
    if (d < bestDist) {
      bestDist = d;
      pivot = i;
    }
  });
  const half = maxM / 2;
  let from = pivot;
  let to = pivot;
  let behind = 0;
  let ahead = 0;
  while (from > 0 && behind < half) {
    behind += haversineM(coords[from - 1], coords[from]);
    from--;
  }
  while (to < coords.length - 1 && ahead < half) {
    ahead += haversineM(coords[to], coords[to + 1]);
    to++;
  }
  return coords.slice(from, to + 1);
}

interface RelationMember {
  type: string;
  role?: string;
  geometry?: { lon?: number; lat?: number }[];
}

interface RelationTags {
  type: string;
  id: number;
  tags?: Record<string, string>;
}

async function queryHikes(cell: Cell): Promise<NearbyHike[]> {
  const b = cellBounds(cell, CELL_ZOOM);
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;
  const elements = await overpassQuery<RelationTags>(
    `[out:json][timeout:25];rel["route"="hiking"]["name"](${bbox});out tags ${MAX_ROUTES_PER_CELL};`,
  );
  const hikes: NearbyHike[] = [];
  for (const el of elements) {
    if (el.type !== 'relation' || !el.tags?.name) continue;
    hikes.push({
      id: el.id,
      name: el.tags.name,
      ref: el.tags.ref ?? '',
      network: el.tags.network ?? '',
      declaredKm: declaredKm(el.tags.distance),
    });
  }
  return hikes;
}

/** the `distance` tag is free text: "165", "165 km", "102.5 mi" */
function declaredKm(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number.parseFloat(raw.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return null;
  const km = /mi/i.test(raw) ? value * 1.609 : value;
  // a marked hiking route shorter than a kilometre is a mistagged unit, not a hike
  return km < 1 ? null : km;
}

function join(chain: LonLat[], way: LonLat[], toleranceM: number): LonLat[] | null {
  const chainStart = chain[0];
  const chainEnd = chain[chain.length - 1];
  const wayStart = way[0];
  const wayEnd = way[way.length - 1];
  if (haversineM(chainEnd, wayStart) <= toleranceM) return [...chain, ...way.slice(1)];
  if (haversineM(chainEnd, wayEnd) <= toleranceM) return [...chain, ...[...way].reverse().slice(1)];
  if (haversineM(chainStart, wayEnd) <= toleranceM) return [...way, ...chain.slice(1)];
  if (haversineM(chainStart, wayStart) <= toleranceM) return [...[...way].reverse(), ...chain.slice(1)];
  return null;
}

function lineLengthM(line: LonLat[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += haversineM(line[i - 1], line[i]);
  return total;
}
