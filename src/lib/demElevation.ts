/**
 * Altitudes lues côté client dans le MNT Terrarium (AWS Open Data).
 *
 * Zéro appel à une API d'altimétrie: les tuiles sont les mêmes que celles déjà utilisées
 * pour le relief 3D et les pentes, décodées dans le navigateur et mises en cache.
 */

import type { LonLat } from './geo';

export const DEM_TILE_SIZE = 256;

const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
// ~19 m/pixel à 45° de latitude: du même ordre que la précision d'un MNT mondial
const SAMPLING_ZOOM = 13;
const CACHE_MAX_TILES = 64;

const tileCache = new Map<string, Promise<Float32Array>>();

/**
 * Récupère et décode une tuile Terrarium en grille d'altitudes (mètres), avec cache LRU.
 *
 * Args:
 *   z: niveau de zoom de la tuile.
 *   x: colonne de la tuile.
 *   y: ligne de la tuile.
 */
export function demTileElevations(z: number, x: number, y: number): Promise<Float32Array> {
  const key = `${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) {
    // rafraîchit la position LRU
    tileCache.delete(key);
    tileCache.set(key, cached);
    return cached;
  }
  const promise = fetchTile(z, x, y).catch(err => {
    tileCache.delete(key);
    throw err;
  });
  tileCache.set(key, promise);
  if (tileCache.size > CACHE_MAX_TILES) {
    const oldest = tileCache.keys().next().value;
    if (oldest) tileCache.delete(oldest);
  }
  return promise;
}

/**
 * Altitudes interpolées (bilinéaire) pour une liste de points.
 *
 * Args:
 *   points: positions lon/lat.
 *
 * Returns:
 *   Une altitude en mètres par point, dans le même ordre.
 */
export async function sampleElevations(points: LonLat[]): Promise<number[]> {
  const n = 2 ** SAMPLING_ZOOM;
  const samples = points.map(([lon, lat]) => {
    const xf = ((lon + 180) / 360) * n * DEM_TILE_SIZE;
    const latRad = (lat * Math.PI) / 180;
    const yf = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n * DEM_TILE_SIZE;
    return { xf, yf, tx: Math.floor(xf / DEM_TILE_SIZE), ty: Math.floor(yf / DEM_TILE_SIZE) };
  });

  const tiles = new Map<string, Promise<Float32Array>>();
  for (const s of samples) {
    const key = `${s.tx}/${s.ty}`;
    if (!tiles.has(key)) tiles.set(key, demTileElevations(SAMPLING_ZOOM, s.tx, s.ty));
  }
  const grids = new Map<string, Float32Array>();
  for (const [key, promise] of tiles) grids.set(key, await promise);

  return samples.map(s => {
    const grid = grids.get(`${s.tx}/${s.ty}`) as Float32Array;
    return bilinear(grid, s.xf - s.tx * DEM_TILE_SIZE, s.yf - s.ty * DEM_TILE_SIZE);
  });
}

async function fetchTile(z: number, x: number, y: number): Promise<Float32Array> {
  const res = await fetch(`${TERRARIUM_URL}/${z}/${x}/${y}.png`);
  if (!res.ok) throw new Error(`terrarium ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(DEM_TILE_SIZE, DEM_TILE_SIZE);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d indisponible');
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE);
  const elevations = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
  for (let i = 0; i < elevations.length; i++) {
    elevations[i] = data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768;
  }
  return elevations;
}

// interpolation bilinéaire entre les 4 pixels voisins, bornée dans la tuile
function bilinear(grid: Float32Array, px: number, py: number): number {
  const clamp = (v: number) => Math.min(DEM_TILE_SIZE - 1, Math.max(0, v));
  const x0 = clamp(Math.floor(px - 0.5));
  const y0 = clamp(Math.floor(py - 0.5));
  const x1 = clamp(x0 + 1);
  const y1 = clamp(y0 + 1);
  const fx = Math.min(1, Math.max(0, px - 0.5 - x0));
  const fy = Math.min(1, Math.max(0, py - 0.5 - y0));
  const top = grid[y0 * DEM_TILE_SIZE + x0] * (1 - fx) + grid[y0 * DEM_TILE_SIZE + x1] * fx;
  const bottom = grid[y1 * DEM_TILE_SIZE + x0] * (1 - fx) + grid[y1 * DEM_TILE_SIZE + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}
