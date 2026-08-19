/**
 * Offline: the app shell and everything already seen keep working without a network.
 *
 * Three caches, three policies:
 * - navigations: network first, falling back to the cached page, so a deploy is picked up
 *   online and the app still opens in a blind spot;
 * - build assets (hashed, immutable): cache first;
 * - map tiles and open-data answers: cache first with an entry cap, so the areas already
 *   browsed stay walkable offline without eating the disk.
 */

const SHELL_CACHE = 'cairn-shell-v1';
const ASSET_CACHE = 'cairn-assets-v1';
const TILE_CACHE = 'cairn-tiles-v1';
/** filled by the in-app "download for offline": never trimmed, checked before everything */
const OFFLINE_CACHE = 'cairn-offline-v1';
const TILE_MAX_ENTRIES = 4000;

/** hosts whose answers are worth keeping for the trail: tiles, DEM, POIs */
const TILE_HOSTS = [
  'data.geopf.fr',
  'tile.openstreetmap.org',
  'a.tile.openstreetmap.org',
  'b.tile.openstreetmap.org',
  'c.tile.openstreetmap.org',
  's3.amazonaws.com',
  'tile.waymarkedtrails.org',
  'www.refuges.info',
  'overpass-api.de',
  'lz4.overpass-api.de',
  'maps.mail.ru',
  'wmts.geo.admin.ch',
  'cartoweb.wmts.ngi.be',
  'a.tile.opentopomap.org',
  'b.tile.opentopomap.org',
  'c.tile.opentopomap.org',
];

self.addEventListener('install', event => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

// the page that installs the worker loaded its scripts before the worker could see them, so
// going offline right after the first visit would reopen an empty shell: the install reads the
// page and pulls its hashed assets into the cache itself
async function precache() {
  const shell = await caches.open(SHELL_CACHE);
  await shell.addAll(['/', '/manifest.webmanifest', '/logo.png']);
  const page = await (await shell.match('/')).text();
  const assets = [...page.matchAll(/["'](\/assets\/[^"']+)["']/g)].map(m => m[1]);
  const assetCache = await caches.open(ASSET_CACHE);
  await assetCache.addAll([...new Set(assets)]);
}

self.addEventListener('activate', event => {
  const keep = [SHELL_CACHE, ASSET_CACHE, TILE_CACHE, OFFLINE_CACHE];
  event.waitUntil(
    caches
      .keys()
      .then(names => Promise.all(names.filter(name => !keep.includes(name)).map(name => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }
  if (url.origin === self.location.origin && url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(ASSET_CACHE, request, Number.POSITIVE_INFINITY));
    return;
  }
  // a forecast ages by the hour: network first, and the cached one only in a dead zone
  if (url.host === 'api.open-meteo.com') {
    event.respondWith(freshFirst(request));
    return;
  }
  if (TILE_HOSTS.includes(url.host)) {
    event.respondWith(cacheFirst(TILE_CACHE, request, TILE_MAX_ENTRIES));
  }
});

async function freshFirst(request) {
  const cache = await caches.open(TILE_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      await cache.put(request, fresh.clone());
      trim(cache, TILE_MAX_ENTRIES);
    }
    return fresh;
  } catch {
    return (await cache.match(request, { ignoreVary: true })) ?? Response.error();
  }
}

async function networkFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) cache.put('/', fresh.clone());
    return fresh;
  } catch {
    return (await cache.match('/')) ?? Response.error();
  }
}

async function cacheFirst(cacheName, request, maxEntries) {
  // a downloaded corridor answers first: those entries were asked for by name and never expire
  const offline = await caches.open(OFFLINE_CACHE);
  const kept = await offline.match(request, { ignoreVary: true });
  if (kept) return kept;
  const cache = await caches.open(cacheName);
  // ignoreVary: servers send `Vary: Origin` on cors answers, and a crossorigin <script> carries
  // an Origin header the precached request lacked; the URL alone is the identity of an asset
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const fresh = await fetch(request);
  // opaque no-cors answers are cached as-is: a tile is a tile
  if (fresh.ok || fresh.type === 'opaque') {
    await cache.put(request, fresh.clone());
    trim(cache, maxEntries);
  }
  return fresh;
}

/** drops the oldest entries past the cap; approximate FIFO is plenty for tiles */
async function trim(cache, maxEntries) {
  if (!Number.isFinite(maxEntries)) return;
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map(key => cache.delete(key)));
}
