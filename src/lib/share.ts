/**
 * Partage d'itinéraire par URL, sans serveur: la route est sérialisée, compressée
 * (deflate natif du navigateur) et encodée en base64url dans le fragment #r=.
 *
 * Seules les ancres et leurs métadonnées voyagent pour les tronçons routés, recalculés
 * à l'ouverture; les géométries figées (import GPX, tracé manuel, aller-retour) voyagent
 * en polyline compressée pour arriver à l'identique.
 */

import { type Anchor, type LegSlot, type OffRoutePoint, usePlanner } from '../store';
import type { RoutingPreset } from './brouter';
import { type LonLatEle, pathDistanceM } from './geo';
import { POINT_KINDS, type PointKind } from './points';

const SHARE_PREFIX = '#r=1.';
const PRECISION_DEG = 1e5;
const PRECISION_ELE = 10;
const PRESETS: readonly RoutingPreset[] = ['balanced', 'avoid_roads', 'easy_up'];

type SharedPoint = [number, number, string, string];

interface SharePayload {
  n: string;
  p: RoutingPreset;
  a: SharedPoint[];
  /** une entrée par tronçon: polyline (lat, lon, ele) si géométrie figée, '' si manuel encore
   * en calcul au moment du partage, null si à rerouter en auto */
  l: (string | null)[];
  o: SharedPoint[];
}

/**
 * URL de partage de l'itinéraire courant, à copier telle quelle.
 *
 * Returns:
 *   URL complète avec la route encodée dans le fragment.
 */
export async function buildShareUrl(): Promise<string> {
  const { anchors, legs, offRoutePoints, currentRouteName, routingPreset } = usePlanner.getState();
  const payload: SharePayload = {
    n: currentRouteName,
    p: routingPreset,
    a: anchors.map(packPoint),
    l: legs.map(slot => (slot.manual ? (slot.leg ? encodeTrack(slot.leg.coords) : '') : null)),
    o: offRoutePoints.map(packPoint),
  };
  const data = await deflateBase64Url(JSON.stringify(payload));
  return `${location.origin}${location.pathname}${SHARE_PREFIX}${data}`;
}

/** Applique la route encodée dans le fragment d'URL, s'il y en a une. */
export async function loadSharedRouteFromUrl(): Promise<void> {
  if (!location.hash.startsWith(SHARE_PREFIX)) return;
  const raw = location.hash.slice(SHARE_PREFIX.length);
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const payload = JSON.parse(await inflateBase64Url(raw)) as SharePayload;
    usePlanner.getState().applySharedRoute({
      name: payload.n ?? '',
      preset: PRESETS.includes(payload.p) ? payload.p : undefined,
      anchors: (payload.a ?? []).map(unpackPoint),
      legs: (payload.l ?? []).map(line => ({
        id: crypto.randomUUID(),
        manual: line !== null,
        leg: line ? makeLeg(decodeTrack(line)) : null,
      })),
      offRoutePoints: (payload.o ?? []).map(unpackPoint),
    });
  } catch {
    usePlanner.setState({ error: 'err_share' });
  }
}

function packPoint(point: Anchor | OffRoutePoint): SharedPoint {
  return [round6(point.lon), round6(point.lat), point.kind, point.name];
}

function unpackPoint([lon, lat, kind, name]: SharedPoint): Anchor {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error('invalid point');
  const knownKind = POINT_KINDS.some(k => k.id === kind) ? (kind as PointKind) : 'autre';
  return { id: crypto.randomUUID(), lon, lat, kind: knownKind, name: String(name ?? '') };
}

function makeLeg(coords: LonLatEle[]): LegSlot['leg'] {
  return { coords, distanceM: pathDistanceM(coords) };
}

function round6(value: number): number {
  return Number(value.toFixed(6));
}

// --- polyline (algorithme Google, deltas signés par dimension: lat, lon, altitude) ---

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

// --- compression deflate + base64url ---

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
