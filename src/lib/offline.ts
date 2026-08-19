/**
 * Taking a route into the dead zone: one tap downloads everything its corridor needs into the
 * Cache Storage, where the service worker serves it back when the network is gone.
 *
 * What goes in: the Plan IGN vector tiles along the route (plus the style, sprite and fonts the
 * map draws them with), the refuges.info cells and the OSM drinking-water cells around it. The
 * route itself already lives in localStorage. What stays out: satellite and 3D relief, whose
 * tiles would weigh hundreds of megabytes for one hike.
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

/** every request the bundle needs, map chrome first so a cancelled download still renders */
export function corridorUrls(coords: LonLatEle[], activeBaseId?: string): string[] {
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
    for (const [x, y] of corridorTiles(coords, z)) {
      urls.push(PLAN_TILES.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
    }
  }
  // every French base map, plus the active one when the trek lives on a foreign base
  const layerIds = new Set(CORE_RASTERS);
  if (activeBaseId && RASTER_ZOOMS[activeBaseId]) layerIds.add(activeBaseId);
  for (const layer of RASTER_BASE_LAYERS) {
    if (!layerIds.has(layer.id)) continue;
    const [zMin, zMax] = RASTER_ZOOMS[layer.id];
    for (let z = zMin; z <= zMax; z++) {
      for (const [x, y] of corridorTiles(coords, z)) {
        urls.push(layer.tiles.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
      }
    }
  }
  // the same URLs the live overlays request, so the cache answers them offline
  for (const [x, y] of corridorTiles(coords, REFUGES_CELL_ZOOM)) urls.push(refugesCellUrl({ x, y }));
  for (const [x, y] of corridorTiles(coords, FOUNTAINS_CELL_ZOOM)) {
    urls.push(overpassUrl(OVERPASS_PRIMARY, fountainsCellQuery({ x, y })));
  }
  return urls;
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
