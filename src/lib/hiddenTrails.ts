/**
 * Faint OpenStreetMap trails: unofficial paths (informal=yes) or paths with degraded
 * visibility (trail_visibility), fetched through the Overpass API, one request per z11 cell.
 */

import { overpassQuery } from './overpass';
import { type Cell, cachedFetch, cellBounds, cellsInBounds, type ViewBounds } from './tileGrid';

export const HIDDEN_TRAILS_MIN_ZOOM = 12;

// z11 cells (~15 km per side): a zoomed viewport fits in 1-4 requests
const CELL_ZOOM = 11;
const MAX_CELLS_PER_VIEW = 6;
const CACHE_MAX_CELLS = 64;
const LOW_VISIBILITY = 'intermediate|bad|horrible|no';

const cellCache = new Map<string, Promise<GeoJSON.Feature[]>>();

/**
 * Faint trails covering the given area.
 *
 * Args:
 *   bounds: viewport extent in degrees.
 *
 * Returns:
 *   GeoJSON lines, or an empty list if the area is too wide (zoom too low).
 */
export async function fetchHiddenTrails(bounds: ViewBounds): Promise<GeoJSON.Feature[]> {
  const cells = cellsInBounds(bounds, CELL_ZOOM);
  if (cells.length === 0 || cells.length > MAX_CELLS_PER_VIEW) return [];
  const results = await Promise.all(
    cells.map(cell =>
      cachedFetch(cellCache, `${cell.x}/${cell.y}`, CACHE_MAX_CELLS, () => queryOverpass(cell)).catch(err => {
        // an overlay must never break the map, but a systematic failure has to be findable
        console.warn('overpass hidden trails', err);
        return [];
      }),
    ),
  );
  return results.flat();
}

async function queryOverpass(cell: Cell): Promise<GeoJSON.Feature[]> {
  const b = cellBounds(cell, CELL_ZOOM);
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;
  const query =
    `[out:json][timeout:20];(` +
    `way["highway"~"^(path|footway)$"]["informal"="yes"](${bbox});` +
    `way["highway"~"^(path|footway)$"]["trail_visibility"~"^(${LOW_VISIBILITY})$"](${bbox});` +
    `);out geom 600;`;
  const elements = await overpassQuery<{
    type: string;
    geometry?: { lon: number; lat: number }[];
    tags?: Record<string, string>;
  }>(query);
  const features: GeoJSON.Feature[] = [];
  for (const el of elements) {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    features.push({
      type: 'Feature',
      properties: { visibility: el.tags?.trail_visibility ?? 'informal' },
      geometry: {
        type: 'LineString',
        coordinates: el.geometry.map((p: { lon: number; lat: number }) => [p.lon, p.lat]),
      },
    });
  }
  return features;
}
