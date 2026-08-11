/**
 * Sentes discrètes d'OpenStreetMap: sentiers non officiels (informal=yes) ou à visibilité
 * dégradée (trail_visibility), récupérés via l'API Overpass, une requête par cellule z11.
 */

import { type Cell, cachedFetch, cellBounds, cellsInBounds, type ViewBounds } from './tileGrid';

export const HIDDEN_TRAILS_MIN_ZOOM = 12;

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// cellules z11 (~15 km de côté): un viewport zoomé tient en 1-4 requêtes
const CELL_ZOOM = 11;
const MAX_CELLS_PER_VIEW = 6;
const CACHE_MAX_CELLS = 64;
const LOW_VISIBILITY = 'intermediate|bad|horrible|no';

const cellCache = new Map<string, Promise<GeoJSON.Feature[]>>();

/**
 * Sentes discrètes couvrant la zone donnée.
 *
 * Args:
 *   bounds: emprise du viewport en degrés.
 *
 * Returns:
 *   Lignes GeoJSON, ou liste vide si la zone est trop large (zoom insuffisant).
 */
export async function fetchHiddenTrails(bounds: ViewBounds): Promise<GeoJSON.Feature[]> {
  const cells = cellsInBounds(bounds, CELL_ZOOM);
  if (cells.length === 0 || cells.length > MAX_CELLS_PER_VIEW) return [];
  const results = await Promise.all(
    cells.map(cell =>
      cachedFetch(cellCache, `${cell.x}/${cell.y}`, CACHE_MAX_CELLS, () => queryOverpass(cell)).catch(() => []),
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
  const res = await fetch(OVERPASS_URL, { method: 'POST', body: `data=${encodeURIComponent(query)}` });
  if (!res.ok) throw new Error(`overpass ${res.status}`);
  const data = await res.json();
  const features: GeoJSON.Feature[] = [];
  for (const el of data.elements ?? []) {
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
