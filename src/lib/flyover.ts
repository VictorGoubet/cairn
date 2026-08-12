/**
 * Drone-like flight along the route, the way Strava plays a activity back.
 *
 * The camera follows the track at a constant ground speed, looks ahead rather than straight
 * down, and banks smoothly instead of snapping at every vertex. 3D terrain is required for
 * the relief to read, so the caller turns it on and restores the previous state at the end.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { cumulativeDistancesM, type LonLatEle, nearestIndex } from './geo';

/** a full route plays in this many seconds, whatever its length */
const FLIGHT_SECONDS = 60;
/**
 * Ground speed cap. Beyond roughly this, the camera outruns tile loading and flies over a
 * blank map: at zoom 14 a tile spans a few hundred meters, and vector plus DEM tiles both
 * have to arrive.
 */
const MAX_SPEED_M_S = 70;
const PITCH_DEG = 68;
/** wide enough to keep the tile budget sane while still feeling low over the ground */
const ZOOM = 14.2;
/** distance looked ahead to pick the heading: shorter reads jittery, longer cuts corners */
const LOOKAHEAD_M = 220;
/** exponential smoothing of the bearing, per frame */
const BEARING_SMOOTHING = 0.12;
/** waiting forever for tiles would leave the play button stuck */
const TAKEOFF_TIMEOUT_MS = 4000;

export interface FlyoverHandle {
  stop(): void;
}

function bearingBetween(from: LonLatEle, to: LonLatEle): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLon = toRad(to[0] - from[0]);
  const lat1 = toRad(from[1]);
  const lat2 = toRad(to[1]);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/** shortest way around the circle, so the camera never spins the long way at 359 to 1 degree */
function shortestTurn(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

function positionAt(coords: LonLatEle[], dists: number[], distanceM: number): LonLatEle {
  const i = Math.max(1, nearestIndex(dists, distanceM));
  const span = dists[i] - dists[i - 1];
  const t = span > 0 ? Math.min(1, Math.max(0, (distanceM - dists[i - 1]) / span)) : 0;
  const a = coords[i - 1];
  const b = coords[i];
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
}

/**
 * Flies the camera along the route until the end, or until `stop()` is called.
 *
 * Args:
 *   map: map to drive; its camera is taken over for the duration.
 *   coords: route geometry, at least two points.
 *   onEnd: called when the flight finishes or is stopped, once.
 *
 * Returns:
 *   A handle to stop the flight early.
 */
export function startFlyover(map: MapLibreMap, coords: LonLatEle[], onEnd: () => void): FlyoverHandle {
  const dists = cumulativeDistancesM(coords);
  const totalM = dists[dists.length - 1];
  const speed = Math.min(MAX_SPEED_M_S, totalM / FLIGHT_SECONDS);

  // maplibre caps the pitch at 60 by default, which is too flat to feel like a flight
  const previousMaxPitch = map.getMaxPitch();
  if (previousMaxPitch < PITCH_DEG) map.setMaxPitch(Math.min(85, PITCH_DEG + 2));

  let frame = 0;
  let done = false;
  let startedAt = 0;
  let bearing = bearingBetween(coords[0], positionAt(coords, dists, Math.min(LOOKAHEAD_M, totalM)));

  const finish = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    map.setMaxPitch(previousMaxPitch);
    onEnd();
  };

  const step = (now: number) => {
    if (done) return;
    if (!startedAt) startedAt = now;
    const travelled = ((now - startedAt) / 1000) * speed;
    const center = positionAt(coords, dists, Math.min(travelled, totalM));
    const ahead = positionAt(coords, dists, Math.min(travelled + LOOKAHEAD_M, totalM));
    const target = travelled + LOOKAHEAD_M >= totalM ? bearing : bearingBetween(center, ahead);
    bearing += shortestTurn(bearing, target) * BEARING_SMOOTHING;

    map.jumpTo({ center: [center[0], center[1]], zoom: ZOOM, pitch: PITCH_DEG, bearing });
    if (travelled >= totalM) return finish();
    frame = requestAnimationFrame(step);
  };

  // frame the start and wait for its tiles: taking off immediately shows a blank map
  map.jumpTo({
    center: [coords[0][0], coords[0][1]],
    zoom: ZOOM,
    pitch: PITCH_DEG,
    bearing,
  });
  const takeOff = () => {
    if (done) return;
    frame = requestAnimationFrame(step);
  };
  map.once('idle', takeOff);
  // never strand the flight if a tile request hangs
  const takeOffFallback = window.setTimeout(takeOff, TAKEOFF_TIMEOUT_MS);

  return {
    stop: () => {
      window.clearTimeout(takeOffFallback);
      map.off('idle', takeOff);
      finish();
    },
  };
}
