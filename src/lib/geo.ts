export type LonLat = [number, number];
export type LonLatEle = [number, number, number];

const EARTH_RADIUS_M = 6_371_000;
const M_PER_DEG_LAT = 111_320;
// hysteresis so DEM noise is not counted in the elevation gain/loss
const ELEVATION_HYSTERESIS_M = 8;

export function haversineM(a: LonLat, b: LonLat): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function cumulativeDistancesM(coords: LonLatEle[]): number[] {
  const out = [0];
  for (let i = 1; i < coords.length; i++) {
    out.push(out[i - 1] + haversineM([coords[i - 1][0], coords[i - 1][1]], [coords[i][0], coords[i][1]]));
  }
  return out;
}

export function elevationStats(coords: LonLatEle[]): { gainM: number; lossM: number } {
  let gain = 0;
  let loss = 0;
  let ref = coords[0]?.[2] ?? 0;
  for (const [, , ele] of coords) {
    const diff = ele - ref;
    if (Math.abs(diff) < ELEVATION_HYSTERESIS_M) continue;
    if (diff > 0) gain += diff;
    else loss -= diff;
    ref = ele;
  }
  return { gainM: gain, lossM: loss };
}

export function formatDistance(meters: number): string {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

// SuisseMobile-style scale: 4.2 km/h on the flat, 400 m/h uphill, 800 m/h downhill
export function hikingDurationH(distanceM: number, gainM: number, lossM: number): number {
  return distanceM / 4200 + gainM / 400 + lossM / 800;
}

export function formatDuration(hours: number): string {
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h === 0 ? `${m} min` : `${h} h ${String(m).padStart(2, '0')}`;
}

export function nearestIndex(sorted: number[], value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1] - value) < Math.abs(sorted[lo] - value)) return lo - 1;
  return lo;
}

/**
 * Ramer-Douglas-Peucker: indices of the vertices that carry the shape of the track.
 *
 * Args:
 *   coords: full track.
 *   toleranceM: maximum tolerated deviation between the track and its simplified version.
 */
export function simplifyIndices(coords: LonLatEle[], toleranceM: number): number[] {
  if (coords.length <= 2) return coords.map((_, i) => i);
  const keep = new Set([0, coords.length - 1]);
  const segments: [number, number][] = [[0, coords.length - 1]];
  while (segments.length > 0) {
    const [start, end] = segments.pop() as [number, number];
    let farthest = -1;
    let maxDistance = 0;
    for (let i = start + 1; i < end; i++) {
      const distance = perpendicularDistanceM(coords[i], coords[start], coords[end]);
      if (distance > maxDistance) {
        maxDistance = distance;
        farthest = i;
      }
    }
    if (farthest < 0 || maxDistance <= toleranceM) continue;
    keep.add(farthest);
    segments.push([start, farthest], [farthest, end]);
  }
  return [...keep].sort((a, b) => a - b);
}

/**
 * Total length of a polyline, in meters.
 *
 * Args:
 *   coords: successive points of the path.
 */
export function pathDistanceM(coords: LonLatEle[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineM([coords[i - 1][0], coords[i - 1][1]], [coords[i][0], coords[i][1]]);
  }
  return total;
}

/**
 * Minimum distance from a point to a polyline, in meters.
 *
 * Args:
 *   point: point to locate.
 *   path: polyline of at least two points.
 */
export function pointToPathDistanceM(point: LonLatEle, path: LonLatEle[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < path.length; i++) {
    best = Math.min(best, perpendicularDistanceM(point, path[i - 1], path[i]));
  }
  return best;
}

export function kmMarkerPoints(
  coords: LonLatEle[],
  dists: number[],
  stepM: number,
): { lon: number; lat: number; km: number }[] {
  const out: { lon: number; lat: number; km: number }[] = [];
  let next = stepM;
  for (let i = 1; i < coords.length; i++) {
    while (dists[i] >= next) {
      const t = (next - dists[i - 1]) / (dists[i] - dists[i - 1] || 1);
      out.push({
        lon: coords[i - 1][0] + t * (coords[i][0] - coords[i - 1][0]),
        lat: coords[i - 1][1] + t * (coords[i][1] - coords[i - 1][1]),
        km: Math.round(next / 1000),
      });
      next += stepM;
    }
  }
  return out;
}

// local planar projection: over a few kilometers the error is negligible against the tolerance
function perpendicularDistanceM(point: LonLatEle, from: LonLatEle, to: LonLatEle): number {
  const metersPerDegLon = M_PER_DEG_LAT * Math.cos((((from[1] + to[1]) / 2) * Math.PI) / 180);
  const px = (point[0] - from[0]) * metersPerDegLon;
  const py = (point[1] - from[1]) * M_PER_DEG_LAT;
  const sx = (to[0] - from[0]) * metersPerDegLon;
  const sy = (to[1] - from[1]) * M_PER_DEG_LAT;
  const lengthSq = sx * sx + sy * sy;
  if (lengthSq === 0) return Math.hypot(px, py);
  const t = Math.min(1, Math.max(0, (px * sx + py * sy) / lengthSq));
  return Math.hypot(px - t * sx, py - t * sy);
}
