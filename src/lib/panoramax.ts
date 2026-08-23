/**
 * Ground-level photos of a place, from Panoramax: the open street-level imagery published by the
 * IGN and OpenStreetMap France, free and without a key.
 *
 * Street View would answer for a car park, not for a meadow at 2200 m, and it needs a paid key.
 * Panoramax is contributed by hikers and cyclists, so its coverage follows trails: at a lake or a
 * col there is often a photo within a couple of hundred metres, and nothing at all in between.
 * The distance is reported next to the picture rather than hidden, because a photo of somewhere
 * else is worse than no photo.
 */

import { haversineM, type LonLat } from './geo';
import { fetchWithTimeout } from './http';

const SEARCH_URL = 'https://api.panoramax.xyz/api/search';
const VIEWER_URL = 'https://panoramax.openstreetmap.fr/';
/** past this the picture shows another place, whatever it shows well */
const LOOK_RADIUS_M = 250;
/** enough to have a choice, few enough to stay a small answer */
const CANDIDATES = 20;
const TIMEOUT_MS = 6000;
const M_PER_DEG_LAT = 111_320;

export interface GroundPhoto {
  thumbUrl: string;
  /** metres between the spot and where the photo was taken */
  distanceM: number;
  /** who took it and under which licence: CC-BY-SA asks for both */
  author: string;
  license: string;
  viewerUrl: string;
}

/**
 * The closest ground photo of a spot, or null when nobody has walked past with a camera.
 *
 * Args:
 *   point: the spot.
 *   radiusM: how far a photo may be taken from it and still show it.
 */
export async function nearestGroundPhoto(point: LonLat, radiusM = LOOK_RADIUS_M): Promise<GroundPhoto | null> {
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLon = dLat / Math.max(0.2, Math.cos((point[1] * Math.PI) / 180));
  const bbox = [point[0] - dLon, point[1] - dLat, point[0] + dLon, point[1] + dLat].map(n => n.toFixed(6)).join(',');
  const url = `${SEARCH_URL}?bbox=${bbox}&limit=${CANDIDATES}`;

  const res = await fetchWithTimeout(url, undefined, TIMEOUT_MS).catch(() => null);
  if (!res?.ok) return null;
  const data: SearchAnswer = await res.json().catch(() => ({}) as SearchAnswer);

  let best: GroundPhoto | null = null;
  for (const feature of data.features ?? []) {
    const thumbUrl = feature.assets?.thumb?.href;
    const at = feature.geometry?.coordinates;
    if (!thumbUrl || !at) continue;
    const distanceM = haversineM(point, [at[0], at[1]]);
    if (distanceM > radiusM || (best !== null && distanceM >= best.distanceM)) continue;
    best = {
      thumbUrl,
      distanceM,
      author: feature.properties?.['geovisio:producer'] ?? 'Panoramax',
      license: feature.properties?.license ?? 'CC-BY-SA',
      viewerUrl: `${VIEWER_URL}#focus=pic&pic=${feature.id}`,
    };
  }
  return best;
}

interface SearchAnswer {
  features?: {
    id: string;
    geometry?: { coordinates: [number, number] };
    assets?: { thumb?: { href: string } };
    properties?: { 'geovisio:producer'?: string; license?: string };
  }[];
}
