/**
 * OpenStreetMap drinking water (amenity=drinking_water): the fountains and taps of towns and
 * parks, fetched through the Overpass API, one request per z10 cell.
 *
 * refuges.info knows the springs of the mountains but nothing below them: over the whole of
 * Paris it holds zero points while OSM maps every Wallace fountain. Both feed the same
 * huts-and-water overlay.
 */

import { overpassQuery } from './overpass';
import { type Cell, cachedFetch, cellBounds, cellsInBounds, type ViewBounds } from './tileGrid';

// z10 cells (~30 km per side): dense metros hold ~1500 fountains per cell, one request each
export const FOUNTAINS_CELL_ZOOM = 10;
const CELL_ZOOM = FOUNTAINS_CELL_ZOOM;
const MAX_CELLS_PER_VIEW = 6;
const CACHE_MAX_CELLS = 64;
const MAX_POINTS_PER_CELL = 1500;

const cellCache = new Map<string, Promise<GeoJSON.Feature[]>>();

/**
 * Public drinking water points covering the given area.
 *
 * Args:
 *   bounds: viewport extent in degrees.
 *
 * Returns:
 *   GeoJSON points shaped like refuges.info ones, or an empty list if the area is too wide.
 */
export async function fetchDrinkingWater(bounds: ViewBounds): Promise<GeoJSON.Feature[]> {
  const cells = cellsInBounds(bounds, CELL_ZOOM);
  if (cells.length === 0 || cells.length > MAX_CELLS_PER_VIEW) return [];
  const results = await Promise.all(
    cells.map(cell =>
      cachedFetch(cellCache, `${cell.x}/${cell.y}`, CACHE_MAX_CELLS, () => queryCell(cell)).catch(err => {
        // an overlay must never break the map, but a systematic failure has to be findable
        console.warn('overpass drinking water', err);
        return [];
      }),
    ),
  );
  return results.flat();
}

/** the exact query a cell makes, exported so the offline download caches the same URL */
export function fountainsCellQuery(cell: Cell): string {
  const b = cellBounds(cell, CELL_ZOOM);
  const bbox = `${b.south},${b.west},${b.north},${b.east}`;
  // a private tap behind a fence quenches nobody
  return (
    `[out:json][timeout:20];` +
    `node["amenity"="drinking_water"]["access"!~"^(private|no)$"](${bbox});` +
    `out ${MAX_POINTS_PER_CELL};`
  );
}

async function queryCell(cell: Cell): Promise<GeoJSON.Feature[]> {
  const elements = await overpassQuery<{ lon: number; lat: number; tags?: Record<string, string> }>(
    fountainsCellQuery(cell),
  );
  return elements
    .filter(el => Number.isFinite(el.lon) && Number.isFinite(el.lat))
    .map(el => ({
      type: 'Feature',
      // same shape as a refuges.info point, so the badge and the popup need no second path
      properties: { nom: el.tags?.name ?? '', type: "point d'eau", cat: 'water', alt: null, lien: '' },
      geometry: { type: 'Point', coordinates: [el.lon, el.lat] },
    }));
}
