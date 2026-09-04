/**
 * Where the French maps stop, and what covers the ground beyond them.
 *
 * The Plan IGN, the SCAN 25 and the orthophotos are national: past the border their tiles come
 * back empty or missing (checked: the ortho answers 404 over Zermatt), and a white screen reads as
 * a broken app rather than as "this map ends here". Knowing the extents lets the map say so and
 * offer the base that does cover the place: the neighbour's own national map where there is one,
 * plain OSM otherwise.
 *
 * The offer stays in the family it was asked in, or says that it cannot. Aerial photographs and a
 * drawn map are not interchangeable, and proposing a neighbour's topographic sheet to somebody
 * looking at imagery reads as a non sequitur — which is exactly how it read.
 *
 * The outline is deliberately coarse, and deliberately generous: it answers "should this map have
 * data here", not "which commune is this". The two mistakes are not symmetrical, which is what the
 * generosity is for. Claiming coverage a few kilometres past the border only costs a hint nobody
 * sees; claiming a hole inside France would put a notice over a map that works.
 *
 * A single rectangle cannot do it, which the first attempt proved by declaring Zermatt French.
 */

import { RASTER_BASE_LAYERS } from '../config/layers';
import { type LonLat, pointInRing } from './geo';

/** bases served by the Géoplateforme, whose data stops at the French border */
const FRENCH_BASES = new Set(['plan-ign', 'scan25', 'ortho']);

type Box = { west: number; south: number; east: number; north: number };

/** metropolitan France, walked clockwise from Dunkerque; the land borders follow the ranges */
const METROPOLITAN: LonLat[] = [
  [2.4, 51.1],
  [4.3, 50.6],
  [6.2, 49.6],
  [7.9, 49.0],
  [7.9, 47.6],
  [7.2, 47.5],
  [6.1, 46.3],
  [7.05, 45.9],
  [7.0, 44.8],
  [7.6, 43.7],
  [4.0, 43.0],
  [3.1, 42.3],
  [-1.8, 43.2],
  [-1.3, 45.0],
  [-2.3, 47.0],
  [-4.9, 47.9],
  [-5.2, 48.8],
  [-1.9, 49.8],
  [0.2, 49.6],
  [1.6, 51.0],
];

/** the islands and the overseas departments, where a box is the whole story */
const ISLAND_BOXES: Box[] = [
  { west: 8.4, south: 41.2, east: 9.7, north: 43.1 },
  { west: -61.9, south: 15.8, east: -60.9, north: 16.6 },
  { west: -61.3, south: 14.3, east: -60.7, north: 15.0 },
  { west: -54.7, south: 2.0, east: -51.5, north: 5.9 },
  { west: 55.1, south: -21.5, east: 55.9, north: -20.8 },
  { west: 44.9, south: -13.1, east: 45.4, north: -12.5 },
];

/** the neighbours who publish their own topographic map, in the order they are offered */
const NEIGHBOUR_BASES: { id: string; box: Box }[] = [
  { id: 'swisstopo', box: { west: 5.8, south: 45.7, east: 10.6, north: 47.9 } },
  { id: 'ngi-be', box: { west: 2.5, south: 49.4, east: 6.5, north: 51.6 } },
];

/** the world map to fall back on: OSM covers everywhere and its tiles come fast, where OpenTopoMap's server crawls */
const GLOBAL_BASE = 'osm';

/**
 * Whether the base on screen has data where the map is looking.
 *
 * Args:
 *   baseId: the active base layer.
 *   lon: longitude of the view centre.
 *   lat: latitude of the view centre.
 */
export function baseCoversView(baseId: string, lon: number, lat: number): boolean {
  if (!FRENCH_BASES.has(baseId)) return true;
  return pointInRing([lon, lat], METROPOLITAN) || ISLAND_BOXES.some(box => inside(box, lon, lat));
}

/**
 * What to offer instead of a base that has run out of ground.
 *
 * Args:
 *   baseId: the base on screen, whose family the offer tries to keep.
 *   lon: longitude of the view centre.
 *   lat: latitude of the view centre.
 *
 * Returns:
 *   The base to switch to, and whether it shows the same kind of thing. A false `sameFamily` is
 *   not a failure: it is the notice's cue to say "here is a map instead" rather than pretend.
 */
export function baseCovering(baseId: string, lon: number, lat: number): { id: string; sameFamily: boolean } {
  if (isImagery(baseId)) {
    const worldImagery = RASTER_BASE_LAYERS.find(layer => layer.imagery && !FRENCH_BASES.has(layer.id));
    if (worldImagery) return { id: worldImagery.id, sameFamily: true };
    return { id: GLOBAL_BASE, sameFamily: false };
  }
  const neighbour = NEIGHBOUR_BASES.find(candidate => inside(candidate.box, lon, lat));
  return { id: neighbour?.id ?? GLOBAL_BASE, sameFamily: true };
}

function isImagery(baseId: string): boolean {
  return RASTER_BASE_LAYERS.some(layer => layer.id === baseId && layer.imagery === true);
}

function inside(box: Box, lon: number, lat: number): boolean {
  return lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north;
}
