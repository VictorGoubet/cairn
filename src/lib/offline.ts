/**
 * Taking the map into the dead zone: one tap downloads a bundle into the Cache Storage, where
 * the service worker serves it back when the network is gone.
 *
 * Two shapes of bundle, one machinery: a **trek** (the corridor around a saved route) and an
 * **area** (whatever the screen frames, for the days you head out without an itinerary). Both
 * carry every base map of the region, the style/sprite/fonts the vector map draws with, and the
 * refuges.info and fountain cells, at the exact URLs the live overlays request. What stays out:
 * the 3D relief, whose DEM tiles would weigh hundreds of megabytes.
 */

import { PLAN_IGN_STYLE_URL, RASTER_BASE_LAYERS } from '../config/layers';
import { FOUNTAINS_CELL_ZOOM, fountainsCellQuery } from './drinkingWater';
import type { LonLatEle } from './geo';
import { OVERPASS_PRIMARY, overpassUrl } from './overpass';
import { REFUGES_CELL_ZOOM, refugesCellUrl } from './refugesInfo';

/** everything the download fetches lands here, never trimmed by the browsing cache's FIFO */
export const OFFLINE_CACHE = 'cairn-offline-v1';

const PLAN_TILES = 'https://data.geopf.fr/tms/1.0.0/PLAN.IGN/{z}/{x}/{y}.pbf';
const PLAN_METADATA = 'https://data.geopf.fr/tms/1.0.0/PLAN.IGN/metadata.json';
const GLYPHS = 'https://data.geopf.fr/annexes/ressources/vectorTiles/fonts/{fontstack}/{range}.pbf';
const SPRITE = 'https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/sprite/PlanIgn';
/** the stacks the Plan IGN style actually references, latin ranges only */
const FONTSTACKS = [
  'Source Sans Pro',
  'Source Sans Pro Regular',
  'Source Sans Pro Semibold',
  'Source Sans Pro Bold',
  'Source Sans Pro Italic',
];
const GLYPH_RANGES = ['0-255', '256-511'];

/** margin around the trace (~2 km): losing the path must not mean losing the map */
const CORRIDOR_DEG = 0.02;
/** the vector source's native ceiling; deeper zooms overzoom from these tiles */
const MIN_ZOOM = 6;
const MAX_ZOOM = 14;
/** per-layer zoom spans for the raster maps: scan25 is what a hiker actually reads offline,
 * so it goes one level deeper than the context layers */
const RASTER_ZOOMS: Record<string, [number, number]> = {
  scan25: [8, 15],
  ortho: [10, 14],
  osm: [8, 14],
  opentopo: [8, 14],
  swisstopo: [8, 15],
  'ngi-be': [8, 15],
};
/** the French core every bundle carries; an international base joins when it is the active one */
const CORE_RASTERS = ['scan25', 'ortho', 'osm'];
/** a runaway geometry must not eat the quota: past this the download refuses */
const MAX_TILES = 12_000;
const CONCURRENCY = 6;

export interface OfflineProgress {
  done: number;
  total: number;
}

export interface AreaBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface OfflineArea {
  id: string;
  name: string;
  bounds: AreaBounds;
  savedAt: string;
  resources: number;
}

/** what one bundle resource weighs on average, measured over the tile services we use */
const AVG_RESOURCE_KB = 24;
/** past this an area download is refused: the honest answer is "frame a smaller place" */
const MAX_AREA_RESOURCES = 9000;
const AREAS_KEY = 'cairn.offline.areas.v1';

/**
 * What downloading this area would cost, for the button to say so before the tap.
 *
 * Args:
 *   bounds: the framed area.
 *   activeBaseId: base layer on screen.
 *
 * Returns:
 *   Resource count, rough megabytes, and whether it fits under the cap.
 */
export function estimateArea(
  bounds: AreaBounds,
  activeBaseId?: string,
): { resources: number; megabytes: number; tooLarge: boolean } {
  const resources = areaUrls(bounds, activeBaseId).length;
  return {
    resources,
    megabytes: bundleMegabytes(resources),
    tooLarge: resources > MAX_AREA_RESOURCES,
  };
}

/**
 * Downloads a framed area for offline use, and remembers it.
 *
 * Args:
 *   bounds: the framed area.
 *   name: what to call it in the list.
 *   onProgress: called after every fetched resource.
 *   activeBaseId: base layer on screen.
 *
 * Returns:
 *   The stored area record.
 */
export async function downloadAreaOffline(
  bounds: AreaBounds,
  name: string,
  onProgress: (progress: OfflineProgress) => void,
  activeBaseId?: string,
): Promise<OfflineArea> {
  const urls = areaUrls(bounds, activeBaseId);
  if (urls.length > MAX_AREA_RESOURCES) throw new Error(`area too large: ${urls.length} resources`);
  await fetchAll(urls, onProgress);
  const area: OfflineArea = {
    id: crypto.randomUUID(),
    name,
    bounds,
    savedAt: new Date().toISOString(),
    resources: urls.length,
  };
  writeAreas([area, ...listOfflineAreas()]);
  return area;
}

/** rough weight of a stored bundle, from its resource count */
export function bundleMegabytes(resources: number): number {
  return Math.round((resources * AVG_RESOURCE_KB) / 1024);
}

export function listOfflineAreas(): OfflineArea[] {
  try {
    const areas = JSON.parse(localStorage.getItem(AREAS_KEY) ?? '[]');
    return Array.isArray(areas) ? areas.filter(a => a?.bounds && typeof a.name === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Forgets an area and frees the tiles only it was holding.
 *
 * Tiles shared with another downloaded area or with a trek stay: what is still needed by
 * something else must survive the deletion.
 */
export async function deleteOfflineArea(id: string): Promise<void> {
  const areas = listOfflineAreas();
  const gone = areas.find(a => a.id === id);
  writeAreas(areas.filter(a => a.id !== id));
  if (!gone) return;
  const stillNeeded = new Set(areas.filter(a => a.id !== id).flatMap(a => areaUrls(a.bounds)));
  const cache = await caches.open(OFFLINE_CACHE);
  await Promise.all(areaUrls(gone.bounds).map(url => (stillNeeded.has(url) ? null : cache.delete(url))));
}

function writeAreas(areas: OfflineArea[]): void {
  try {
    localStorage.setItem(AREAS_KEY, JSON.stringify(areas));
  } catch {
    // a full storage loses the list, not the cached tiles
  }
}

const STATE_KEY = 'cairn.offline.v1';

/** ISO date a route's corridor was downloaded, or null */
export function offlineSavedAt(routeId: string): string | null {
  try {
    const state = JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') as Record<string, string>;
    return state[routeId] ?? null;
  } catch {
    return null;
  }
}

export function markOfflineSaved(routeId: string): void {
  try {
    const state = JSON.parse(localStorage.getItem(STATE_KEY) ?? '{}') as Record<string, string>;
    state[routeId] = new Date().toISOString();
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // full storage loses the badge, not the cached tiles
  }
}

/**
 * Downloads a route's trek bundle for offline use.
 *
 * Args:
 *   coords: route geometry.
 *   onProgress: called after every fetched resource.
 *   activeBaseId: the base layer on screen, bundled too when it is not part of the French core.
 *
 * Returns:
 *   How many resources the bundle holds, all fetched (failures are retried once, then let go:
 *   a hole in the cache degrades one tile, not the download).
 */
export async function downloadRouteOffline(
  coords: LonLatEle[],
  onProgress: (progress: OfflineProgress) => void,
  activeBaseId?: string,
): Promise<OfflineProgress> {
  const urls = corridorUrls(coords, activeBaseId);
  if (urls.length > MAX_TILES) throw new Error(`corridor too large: ${urls.length} tiles`);
  return fetchAll(urls, onProgress);
}

/** fetches every url into the offline cache, a few at a time, reporting as it goes */
async function fetchAll(urls: string[], onProgress: (progress: OfflineProgress) => void): Promise<OfflineProgress> {
  const cache = await caches.open(OFFLINE_CACHE);
  let done = 0;
  const queue = [...urls];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      await fetchInto(cache, url);
      done++;
      onProgress({ done, total: urls.length });
    }
  });
  await Promise.all(workers);
  return { done, total: urls.length };
}

/** every request a route's corridor needs */
export function corridorUrls(coords: LonLatEle[], activeBaseId?: string): string[] {
  return bundleUrls(z => corridorTiles(coords, z), activeBaseId);
}

/** every request a framed area needs */
export function areaUrls(bounds: AreaBounds, activeBaseId?: string): string[] {
  return bundleUrls(z => boundsTiles(bounds, z), activeBaseId);
}

/**
 * The bundle for whatever tiles a shape covers, map chrome first so a cancelled download
 * still renders.
 *
 * Args:
 *   tilesAt: the tiles the shape covers at a given zoom.
 *   activeBaseId: base layer on screen, bundled when it is not part of the French core.
 */
function bundleUrls(tilesAt: (z: number) => [number, number][], activeBaseId?: string): string[] {
  const urls = [
    PLAN_IGN_STYLE_URL,
    PLAN_METADATA,
    `${SPRITE}.json`,
    `${SPRITE}.png`,
    `${SPRITE}@2x.json`,
    `${SPRITE}@2x.png`,
    ...FONTSTACKS.flatMap(stack =>
      GLYPH_RANGES.map(range => GLYPHS.replace('{fontstack}', encodeURIComponent(stack)).replace('{range}', range)),
    ),
  ];
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    for (const [x, y] of tilesAt(z)) {
      urls.push(PLAN_TILES.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
    }
  }
  // every French base map, plus the active one when the bundle sits on a foreign base
  const layerIds = new Set(CORE_RASTERS);
  if (activeBaseId && RASTER_ZOOMS[activeBaseId]) layerIds.add(activeBaseId);
  for (const layer of RASTER_BASE_LAYERS) {
    if (!layerIds.has(layer.id)) continue;
    const [zMin, zMax] = RASTER_ZOOMS[layer.id];
    for (let z = zMin; z <= zMax; z++) {
      for (const [x, y] of tilesAt(z)) {
        urls.push(layer.tiles.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
      }
    }
  }
  // the same URLs the live overlays request, so the cache answers them offline
  for (const [x, y] of tilesAt(REFUGES_CELL_ZOOM)) urls.push(refugesCellUrl({ x, y }));
  for (const [x, y] of tilesAt(FOUNTAINS_CELL_ZOOM)) {
    urls.push(overpassUrl(OVERPASS_PRIMARY, fountainsCellQuery({ x, y })));
  }
  return [...new Set(urls)];
}

/** every tile of zoom `z` inside the bounds */
export function boundsTiles(bounds: AreaBounds, z: number): [number, number][] {
  const n = 2 ** z;
  const [xMin, xMax] = [tileX(bounds.west, n), tileX(bounds.east, n)];
  const [yMin, yMax] = [tileY(bounds.north, n), tileY(bounds.south, n)];
  const tiles: [number, number][] = [];
  for (let x = Math.max(xMin, 0); x <= Math.min(xMax, n - 1); x++) {
    for (let y = Math.max(yMin, 0); y <= Math.min(yMax, n - 1); y++) tiles.push([x, y]);
  }
  return tiles;
}

function tileX(lon: number, n: number): number {
  return Math.floor(((lon + 180) / 360) * n);
}

function tileY(lat: number, n: number): number {
  const rad = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
}

/** distinct tiles of zoom `z` within the corridor around the trace */
export function corridorTiles(coords: LonLatEle[], z: number): [number, number][] {
  const n = 2 ** z;
  const seen = new Set<string>();
  const tiles: [number, number][] = [];
  for (const [lon, lat] of coords) {
    for (const dLon of [-CORRIDOR_DEG, 0, CORRIDOR_DEG]) {
      for (const dLat of [-CORRIDOR_DEG, 0, CORRIDOR_DEG]) {
        const x = Math.floor(((lon + dLon + 180) / 360) * n);
        const rad = ((lat + dLat) * Math.PI) / 180;
        const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const key = `${x}/${y}`;
        if (!seen.has(key)) {
          seen.add(key);
          tiles.push([x, y]);
        }
      }
    }
  }
  return tiles;
}

async function fetchInto(cache: Cache, url: string, retried = false): Promise<void> {
  try {
    const hit = await cache.match(url, { ignoreVary: true });
    if (hit) return;
    const res = await fetch(url);
    if (res.ok) await cache.put(url, res);
  } catch {
    if (!retried) await fetchInto(cache, url, true);
  }
}
