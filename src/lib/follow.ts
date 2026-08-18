/**
 * Follow mode: where you are on the loaded route, and what comes next.
 *
 * Deliberately not turn-by-turn navigation. It answers the three questions a hiker actually
 * asks mid-walk (am I still on the trail, how far to the next point, how much is left), from
 * the browser's own geolocation and the route already on screen. No rerouting, no instructions,
 * no voice: the trace is the plan, this only says where you are on it.
 */

import { cumulativeDistancesM, elevationStats, haversineM, hikingDurationH, type LonLat, type LonLatEle } from './geo';
import { emitProgress } from './routeProgress';

/** past this distance from the trace, "you are on the route" would be a lie */
export const OFF_ROUTE_M = 60;

export interface FollowPoi {
  name: string;
  distM: number;
}

export interface FollowFix {
  position: LonLat;
  accuracyM: number;
  /** distance from the trace, in metres */
  offRouteM: number;
  /** how far along the route the fix projects */
  travelledM: number;
  remainingM: number;
  remainingGainM: number;
  remainingHours: number;
  /** the next annotated point ahead, with what it takes to get there */
  next: { name: string; distanceM: number; gainM: number } | null;
}

export interface FollowHandle {
  stop(): void;
}

const FIX_EVENT = 'cairn:follow-fix';

/**
 * Subscribes to the live fixes, for whoever draws them.
 *
 * The bar owns the geolocation watch and the map only listens, which keeps a position arriving
 * every second out of the store and out of React's render path.
 *
 * Args:
 *   listener: receives each fix.
 *
 * Returns:
 *   An unsubscribe function.
 */
export function onFollowFix(listener: (fix: FollowFix) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<FollowFix>).detail);
  window.addEventListener(FIX_EVENT, handler);
  return () => window.removeEventListener(FIX_EVENT, handler);
}

/**
 * Watches the device position and reports it against the route.
 *
 * Args:
 *   coords: route geometry with elevations.
 *   pois: annotated points, with their distance along the route.
 *   onFix: called on every position update.
 *   onError: called when the browser refuses or loses the position.
 *
 * Returns:
 *   A handle to stop watching.
 */
export function startFollow(
  coords: LonLatEle[],
  pois: FollowPoi[],
  onFix: (fix: FollowFix) => void,
  onError: () => void,
): FollowHandle {
  if (!navigator.geolocation) {
    onError();
    return { stop: () => undefined };
  }
  const dists = cumulativeDistancesM(coords);
  const ahead = [...pois].sort((a, b) => a.distM - b.distM);

  const watch = navigator.geolocation.watchPosition(
    position => {
      const here: LonLat = [position.coords.longitude, position.coords.latitude];
      const fix = locate(coords, dists, ahead, here, position.coords.accuracy ?? 0);
      emitProgress(fix.travelledM);
      window.dispatchEvent(new CustomEvent<FollowFix>(FIX_EVENT, { detail: fix }));
      onFix(fix);
    },
    onError,
    { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 },
  );
  return { stop: () => navigator.geolocation.clearWatch(watch) };
}

/**
 * Projects a position onto the route and measures what is left.
 *
 * Exported for the tests: the arithmetic of "how far to the next point" is the whole feature,
 * and it deserves to be checked without a browser and a GPS.
 *
 * Args:
 *   coords: route geometry with elevations.
 *   dists: cumulative distances along `coords`.
 *   pois: annotated points sorted by distance along the route.
 *   here: current position.
 *   accuracyM: radius the browser reports.
 */
export function locate(
  coords: LonLatEle[],
  dists: number[],
  pois: FollowPoi[],
  here: LonLat,
  accuracyM: number,
): FollowFix {
  let index = 0;
  let offRouteM = Number.POSITIVE_INFINITY;
  coords.forEach((c, i) => {
    const d = haversineM(here, [c[0], c[1]]);
    if (d < offRouteM) {
      offRouteM = d;
      index = i;
    }
  });
  const totalM = dists[dists.length - 1];
  const travelledM = dists[index];
  const { gainM, lossM } = elevationStats(coords.slice(index));
  const next = pois.find(p => p.distM > travelledM + 5) ?? null;
  return {
    position: here,
    accuracyM,
    offRouteM,
    travelledM,
    remainingM: totalM - travelledM,
    remainingGainM: gainM,
    remainingHours: hikingDurationH(totalM - travelledM, gainM, lossM),
    next: next
      ? {
          name: next.name,
          distanceM: next.distM - travelledM,
          gainM: elevationStats(coords.slice(index, nearestBefore(dists, next.distM) + 1)).gainM,
        }
      : null,
  };
}

/** index of the last route point at or before `distM` */
function nearestBefore(dists: number[], distM: number): number {
  let index = 0;
  for (let i = 0; i < dists.length; i++) {
    if (dists[i] > distM) break;
    index = i;
  }
  return index;
}
