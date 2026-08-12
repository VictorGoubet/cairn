/**
 * Web-Mercator tile grid and per-cell request cache.
 *
 * Overlays loaded on the fly (OSM trails, refuges.info) split the viewport into cells aligned
 * on this grid: one network request per cell, memoized for the session, to stay light on the
 * volunteer-run APIs whatever the number of users.
 */

export interface ViewBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface Cell {
  x: number;
  y: number;
}

/**
 * Enumerates the tiles of the given level covering the bounds.
 *
 * Args:
 *   bounds: bounds in degrees.
 *   zoom: grid level.
 */
export function cellsInBounds(bounds: ViewBounds, zoom: number): Cell[] {
  const n = 2 ** zoom;
  const toX = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const toY = (lat: number) => {
    const rad = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n);
  };
  const cells: Cell[] = [];
  for (let x = toX(bounds.west); x <= toX(bounds.east); x++) {
    for (let y = toY(bounds.north); y <= toY(bounds.south); y++) {
      cells.push({ x, y });
    }
  }
  return cells;
}

/**
 * Geographic bounds of a tile.
 *
 * Args:
 *   cell: tile coordinates.
 *   zoom: grid level.
 */
export function cellBounds(cell: Cell, zoom: number): ViewBounds {
  const n = 2 ** zoom;
  const lon = (x: number) => (x / n) * 360 - 180;
  const lat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { west: lon(cell.x), east: lon(cell.x + 1), north: lat(cell.y), south: lat(cell.y + 1) };
}

/**
 * Memoized fetch with LRU eviction; a failing entry is removed from the cache.
 *
 * Args:
 *   cache: shared cache owned by the calling module.
 *   key: cell key.
 *   maxSize: maximum cache size.
 *   fetcher: actual loading, called once per key.
 */
export function cachedFetch<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  maxSize: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = fetcher().catch(err => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, promise);
  if (cache.size > maxSize) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return promise;
}
