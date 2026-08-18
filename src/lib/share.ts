/**
 * Route sharing over the URL: the route is serialized, compressed (native browser deflate) and
 * base64url-encoded into the #r= fragment.
 *
 * Routed legs only carry their anchors and metadata, and are recomputed on open; frozen
 * geometries (GPX import, manual drawing, out and back) travel as a compressed polyline so
 * they arrive identical.
 *
 * That link works with no server at all, but it is long and it previews as nothing: a chat app
 * only ever sees the part before the `#`. So when the deployment has a key-value store, sharing
 * first tries a short link: the route and a rendered thumbnail are stored server-side under a
 * ten-character id, and `/s/<id>` serves the app with that route's Open Graph tags. Without the
 * store, or offline, the long link is still what gets copied.
 */

import { type Anchor, type LegSlot, type OffRoutePoint, routeCoords, usePlanner } from '../store';
import type { RoutingPreset } from './brouter';
import { elevationStats, formatDistance, formatDuration, type LonLatEle, pathDistanceM } from './geo';
import { durationH } from './hikingTime';
import { parseKind } from './points';
import { renderLinkPreview } from './shareImage';

const SHARE_PREFIX = '#r=1.';
const SHORT_PREFIX = '/s/';
/** the fragment the fallback preview page redirects to */
const SHORT_HASH = '#s=';
const PRECISION_DEG = 1e5;
const PRECISION_ELE = 10;
const PRESETS: readonly RoutingPreset[] = ['balanced', 'avoid_roads', 'easy_up', 'shortest', 'fastest'];

type SharedPoint = [number, number, string, string];

/** the last link handed out, so an unchanged route is not uploaded twice */
let lastShare: { data: string; url: string } | null = null;

interface SharePayload {
  n: string;
  p: RoutingPreset;
  a: SharedPoint[];
  /** one entry per leg: polyline (lat, lon, ele) for a frozen geometry, '' for a manual leg still
   * being computed when sharing, null when it must be rerouted automatically */
  l: (string | null)[];
  o: SharedPoint[];
}

/**
 * Share URL for the current route, ready to be copied as is.
 *
 * Returns:
 *   Full URL with the route encoded in the fragment.
 */
export async function buildShareUrl(): Promise<string> {
  const data = await encodeRoute();
  return `${location.origin}${location.pathname}${SHARE_PREFIX}${data}`;
}

/**
 * Share URL for the current route, short and previewable when the deployment can store it.
 *
 * Returns:
 *   A `/s/<id>` URL, or the self-contained long URL when there is no store to talk to.
 */
export async function buildPreviewableShareUrl(): Promise<string> {
  const data = await encodeRoute();
  const long = `${location.origin}${location.pathname}${SHARE_PREFIX}${data}`;
  const { currentRouteName, legs } = usePlanner.getState();
  const coords = routeCoords(legs);
  if (coords.length < 2) return long;
  // clicking share twice on an untouched route: the link is already known, and rendering a tile
  // to upload it again would only cost a round trip
  if (lastShare?.data === data) return lastShare.url;
  try {
    const res = await fetch('/api/share', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        payload: data,
        name: currentRouteName,
        description: statsLine(coords),
        image: await renderLinkPreview(coords, currentRouteName),
      }),
    });
    if (!res.ok) return long;
    const { id } = (await res.json()) as { id?: string };
    if (!id) return long;
    const url = `${location.origin}${SHORT_PREFIX}${id}`;
    lastShare = { data, url };
    return url;
  } catch {
    // no store, no network, nothing rendered: the long link says the same thing
    return long;
  }
}

/** Applies the route the URL points at, encoded in its fragment or stored behind a short link. */
export async function loadSharedRouteFromUrl(): Promise<void> {
  const shortId = location.pathname.startsWith(SHORT_PREFIX)
    ? location.pathname.slice(SHORT_PREFIX.length)
    : location.hash.startsWith(SHORT_HASH)
      ? location.hash.slice(SHORT_HASH.length)
      : null;
  const inline = location.hash.startsWith(SHARE_PREFIX) ? location.hash.slice(SHARE_PREFIX.length) : null;
  if (!shortId && !inline) return;

  history.replaceState(null, '', shortId ? '/' : location.pathname + location.search);
  try {
    const data = inline ?? (await fetchSharedPayload(shortId as string));
    applyPayload(JSON.parse(await inflateBase64Url(data)) as SharePayload);
  } catch {
    usePlanner.setState({ error: 'err_share' });
  }
}

function applyPayload(payload: SharePayload): void {
  usePlanner.getState().applySharedRoute({
    name: payload.n ?? '',
    preset: PRESETS.includes(payload.p) ? payload.p : undefined,
    anchors: (payload.a ?? []).map(unpackPoint),
    legs: (payload.l ?? []).map(line => ({
      id: crypto.randomUUID(),
      manual: line !== null,
      leg: line ? makeLeg(decodeValidTrack(line)) : null,
    })),
    offRoutePoints: (payload.o ?? []).map(unpackPoint),
  });
}

async function encodeRoute(): Promise<string> {
  const { anchors, legs, offRoutePoints, currentRouteName, routingPreset } = usePlanner.getState();
  const payload: SharePayload = {
    n: currentRouteName,
    p: routingPreset,
    a: anchors.map(packPoint),
    l: legs.map(slot => (slot.manual ? (slot.leg ? encodeTrack(slot.leg.coords) : '') : null)),
    o: offRoutePoints.map(packPoint),
  };
  return deflateBase64Url(JSON.stringify(payload));
}

async function fetchSharedPayload(id: string): Promise<string> {
  const res = await fetch(`/api/share?id=${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`share ${res.status}`);
  const { payload } = (await res.json()) as { payload?: string };
  if (!payload) throw new Error('empty share');
  return payload;
}

/** the one line a chat app shows under the link title */
function statsLine(coords: LonLatEle[]): string {
  const { gainM } = elevationStats(coords);
  const hours = durationH(coords, usePlanner.getState().profile);
  return `${formatDistance(pathDistanceM(coords))} · +${Math.round(gainM)} m · ${formatDuration(hours)}`;
}

function packPoint(point: Anchor | OffRoutePoint): SharedPoint {
  return [round6(point.lon), round6(point.lat), point.kind, point.name];
}

function unpackPoint([lon, lat, kind, name]: SharedPoint): Anchor {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error('invalid point');
  return { id: crypto.randomUUID(), lon, lat, kind: parseKind(kind), name: String(name ?? '') };
}

function makeLeg(coords: LonLatEle[]): LegSlot['leg'] {
  return { coords, distanceM: pathDistanceM(coords) };
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

// --- polyline (Google algorithm, signed deltas per dimension: lat, lon, elevation) ---

function encodeTrack(coords: LonLatEle[]): string {
  let out = '';
  const prev = [0, 0, 0];
  for (const [lon, lat, ele] of coords) {
    const vals = [Math.round(lat * PRECISION_DEG), Math.round(lon * PRECISION_DEG), Math.round(ele * PRECISION_ELE)];
    for (let d = 0; d < 3; d++) {
      out += encodeValue(vals[d] - prev[d]);
      prev[d] = vals[d];
    }
  }
  return out;
}

/** rejects a polyline whose bytes decoded into anything but real coordinates */
function decodeValidTrack(line: string): LonLatEle[] {
  const coords = decodeTrack(line);
  const usable = coords.every(
    ([lon, lat, ele]) =>
      Number.isFinite(lon) &&
      Number.isFinite(lat) &&
      Number.isFinite(ele) &&
      Math.abs(lon) <= 180 &&
      Math.abs(lat) <= 90,
  );
  if (coords.length < 2 || !usable) throw new Error('invalid shared track');
  return coords;
}

function decodeTrack(line: string): LonLatEle[] {
  const coords: LonLatEle[] = [];
  const vals = [0, 0, 0];
  let pos = 0;
  while (pos < line.length) {
    for (let d = 0; d < 3; d++) {
      let result = 0;
      let shift = 0;
      let byte = 0x20;
      while (byte >= 0x20) {
        byte = line.charCodeAt(pos++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      }
      vals[d] += result & 1 ? ~(result >> 1) : result >> 1;
    }
    coords.push([vals[1] / PRECISION_DEG, vals[0] / PRECISION_DEG, vals[2] / PRECISION_ELE]);
  }
  return coords;
}

function encodeValue(delta: number): string {
  let v = delta < 0 ? ~(delta << 1) : delta << 1;
  let out = '';
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return out + String.fromCharCode(v + 63);
}

// --- deflate compression + base64url ---

async function deflateBase64Url(text: string): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return base64UrlEncode(new Uint8Array(await new Response(stream).arrayBuffer()));
}

async function inflateBase64Url(data: string): Promise<string> {
  const stream = new Blob([base64UrlDecode(data)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
