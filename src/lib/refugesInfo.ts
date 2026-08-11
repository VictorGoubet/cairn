/**
 * Points refuges.info: cabanes, refuges, points d'eau, sommets, passages délicats.
 *
 * API ouverte en lecture seule, sans clé, données CC BY-SA. Une requête par cellule z9
 * (~50 km), mémorisée pour la session.
 */

import { type Cell, cachedFetch, cellBounds, cellsInBounds, type ViewBounds } from './tileGrid';

export const REFUGES_MIN_ZOOM = 10;
export const REFUGES_ATTRIBUTION = '© <a href="https://www.refuges.info" target="_blank">refuges.info</a>';

export type RefugeCategory = 'refuge' | 'eau' | 'sommet' | 'passage' | 'autre';

export const REFUGE_CATEGORY_COLORS: Record<RefugeCategory, string> = {
  refuge: '#e8590c',
  eau: '#1c7ed6',
  sommet: '#7048e8',
  passage: '#e03131',
  autre: '#868e96',
};

export const REFUGE_CATEGORY_EMOJI: Record<RefugeCategory, string> = {
  refuge: '🛖',
  eau: '💧',
  sommet: '⛰️',
  passage: '⚠️',
  autre: '📍',
};

const API_URL = 'https://www.refuges.info/api/bbox';
const CELL_ZOOM = 9;
const MAX_CELLS_PER_VIEW = 6;
const CACHE_MAX_CELLS = 32;
const CATEGORY_BY_TYPE: Record<string, RefugeCategory> = {
  'cabane non gardée': 'refuge',
  'refuge gardé': 'refuge',
  "gîte d'étape": 'refuge',
  "point d'eau": 'eau',
  lac: 'eau',
  sommet: 'sommet',
  'passage délicat': 'passage',
};

const cellCache = new Map<string, Promise<GeoJSON.Feature[]>>();

/**
 * Points refuges.info couvrant la zone donnée.
 *
 * Args:
 *   bounds: emprise du viewport en degrés.
 *
 * Returns:
 *   Points GeoJSON avec nom, catégorie, altitude et lien, ou liste vide si zone trop large.
 */
export async function fetchRefugePoints(bounds: ViewBounds): Promise<GeoJSON.Feature[]> {
  const cells = cellsInBounds(bounds, CELL_ZOOM);
  if (cells.length === 0 || cells.length > MAX_CELLS_PER_VIEW) return [];
  const results = await Promise.all(
    cells.map(cell =>
      cachedFetch(cellCache, `${cell.x}/${cell.y}`, CACHE_MAX_CELLS, () => queryCell(cell)).catch(() => []),
    ),
  );
  return results.flat();
}

async function queryCell(cell: Cell): Promise<GeoJSON.Feature[]> {
  const b = cellBounds(cell, CELL_ZOOM);
  const bbox = `${b.west},${b.south},${b.east},${b.north}`;
  const res = await fetch(`${API_URL}?bbox=${bbox}&format=geojson&type_points=all`);
  if (!res.ok) throw new Error(`refuges.info ${res.status}`);
  const data = await res.json();
  const features: GeoJSON.Feature[] = [];
  for (const f of data.features ?? []) {
    const props = f.properties ?? {};
    const type: string = props.type?.valeur ?? '';
    features.push({
      type: 'Feature',
      properties: {
        nom: props.nom ?? '',
        type,
        cat: CATEGORY_BY_TYPE[type] ?? 'autre',
        alt: props.coord?.alt ?? null,
        lien: props.lien ?? '',
      },
      geometry: f.geometry,
    });
  }
  return features;
}
