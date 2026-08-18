/**
 * refuges.info points: huts, shelters, water points, summits, tricky passages.
 *
 * Open read-only API, no key, CC BY-SA data. One request per z9 cell (~50 km), memoized
 * for the session.
 */

import { fetchWithTimeout } from './http';
import { type Cell, cachedFetch, cellBounds, cellsInBounds, type ViewBounds } from './tileGrid';

export const REFUGES_MIN_ZOOM = 10;
export const REFUGES_ATTRIBUTION = '© <a href="https://www.refuges.info" target="_blank">refuges.info</a>';

export type RefugeCategory = 'hut' | 'water' | 'summit' | 'tricky' | 'other';

export const REFUGE_CATEGORY_COLORS: Record<RefugeCategory, string> = {
  hut: '#e8590c',
  water: '#1c7ed6',
  summit: '#7048e8',
  tricky: '#e03131',
  other: '#868e96',
};

export const REFUGE_CATEGORY_EMOJI: Record<RefugeCategory, string> = {
  hut: '🛖',
  water: '💧',
  summit: '⛰️',
  tricky: '⚠️',
  other: '📍',
};

const API_URL = 'https://www.refuges.info/api/bbox';
/** every type in the cell; `type_points` takes ids, and a bogus value makes the API answer text */
const MAX_POINTS_PER_CELL = 500;
const CELL_ZOOM = 9;
const MAX_CELLS_PER_VIEW = 6;
const CACHE_MAX_CELLS = 32;
const CATEGORY_BY_TYPE: Record<string, RefugeCategory> = {
  'cabane non gardée': 'hut',
  'refuge gardé': 'hut',
  "gîte d'étape": 'hut',
  "point d'eau": 'water',
  lac: 'water',
  sommet: 'summit',
  'passage délicat': 'tricky',
};

const cellCache = new Map<string, Promise<GeoJSON.Feature[]>>();

/**
 * refuges.info points covering the given area.
 *
 * Args:
 *   bounds: viewport extent in degrees.
 *
 * Returns:
 *   GeoJSON points with name, category, elevation and link, or an empty list if the area is too wide.
 */
export async function fetchRefugePoints(bounds: ViewBounds): Promise<GeoJSON.Feature[]> {
  const cells = cellsInBounds(bounds, CELL_ZOOM);
  if (cells.length === 0 || cells.length > MAX_CELLS_PER_VIEW) return [];
  const results = await Promise.all(
    cells.map(cell =>
      cachedFetch(cellCache, `${cell.x}/${cell.y}`, CACHE_MAX_CELLS, () => queryCell(cell)).catch(err => {
        // an overlay must never break the map, but a systematic failure has to be findable
        console.warn('refuges.info', err);
        return [];
      }),
    ),
  );
  return results.flat();
}

async function queryCell(cell: Cell): Promise<GeoJSON.Feature[]> {
  const b = cellBounds(cell, CELL_ZOOM);
  const bbox = `${b.west},${b.south},${b.east},${b.north}`;
  const res = await fetchWithTimeout(`${API_URL}?bbox=${bbox}&format=geojson&nb_points=${MAX_POINTS_PER_CELL}`);
  if (!res.ok) throw new Error(`refuges.info ${res.status}`);
  // the API answers 200 with a plain-text message when a parameter is wrong, so an ok status
  // proves nothing: without this check a rejected request reads as an empty area
  const body = await res.text();
  if (!body.startsWith('{')) throw new Error(`refuges.info refused the query: ${body.slice(0, 80)}`);
  const data = JSON.parse(body);
  const features: GeoJSON.Feature[] = [];
  for (const f of data.features ?? []) {
    const props = f.properties ?? {};
    const type: string = props.type?.valeur ?? '';
    features.push({
      type: 'Feature',
      properties: {
        nom: props.nom ?? '',
        type,
        cat: CATEGORY_BY_TYPE[type] ?? 'other',
        alt: props.coord?.alt ?? null,
        lien: props.lien ?? '',
      },
      geometry: f.geometry,
    });
  }
  return features;
}
