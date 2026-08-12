/**
 * Drone-like flight along the route, the way Strava plays an activity back.
 *
 * Built on the two-path technique Mapbox documents for camera paths: one path carries the
 * camera, a second carries what it looks at, both sampled at the same progress. MapLibre has
 * no FreeCameraOptions, but `calculateCameraOptionsFromTo` does the same job: give it a camera
 * position with an altitude plus a target, and it derives center, zoom, pitch and bearing.
 * Letting geometry drive the camera beats animating pitch and zoom by hand.
 *
 * The caller pins terrain exaggeration to 1 for the flight: MapLibre drops the closest tiles
 * when terrain is on, and the effect grows with exaggeration (maplibre-gl-js issue 1241),
 * which is what makes chunks of the map vanish mid-flight.
 */

import { LngLat, type Map as MapLibreMap } from 'maplibre-gl';
import { cumulativeDistancesM, type LonLatEle, nearestIndex } from './geo';

/** a full route plays in about this long, whatever its length */
const FLIGHT_SECONDS = 30;
/**
 * Ground speed cap. The camera flies high enough to see far ahead, so a brisk pass is fine,
 * but past this the map cannot stream tiles in time.
 */
const MAX_SPEED_M_S = 170;
/**
 * How far ahead the camera looks, and how high it flies. Together they set the pitch and the
 * zoom MapLibre derives: measured at this latitude, looking 2300 m ahead from 850 m up lands
 * around zoom 14.4 and pitch 70, and keeping that ratio holds the framing at any scale. Flying
 * closer (540 m ahead, 430 m up) landed at zoom 16.9 and asked for roughly thirty times as many
 * tiles for the same ground.
 */
const MAX_AHEAD_M = 2300;
const HEIGHT_TO_AHEAD = 850 / 2300;
/** short routes look ahead a fraction of their length, or the flight starts by staring at the end */
const AHEAD_FRACTION = 0.4;
const MIN_AHEAD_M = 220;
/** exponential smoothing on the camera altitude, so a cliff does not jerk the camera */
const ALTITUDE_SMOOTHING = 0.08;
/** samples over the look-ahead window, to clear the relief the camera is heading into */
const LOOKAHEAD_SAMPLES = 8;
/** 30 frames per second is smooth enough here and halves the camera work of 60 */
const FRAME_INTERVAL_MS = 33;
/** terrain exaggeration during the flight, see the note above about vanishing tiles */
export const FLYOVER_EXAGGERATION = 1;
/** tiles are worth a short wait, but past this the flight starts anyway: pressing play and
 * watching nothing happen reads as broken */
const TAKEOFF_TIMEOUT_MS = 1800;

export interface FlyoverHandle {
  stop(): void;
}

function positionAt(coords: LonLatEle[], dists: number[], distanceM: number): LonLatEle {
  const clamped = Math.min(Math.max(distanceM, 0), dists[dists.length - 1]);
  const i = Math.max(1, nearestIndex(dists, clamped));
  const span = dists[i] - dists[i - 1];
  const t = span > 0 ? Math.min(1, Math.max(0, (clamped - dists[i - 1]) / span)) : 0;
  const a = coords[i - 1];
  const b = coords[i];
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
}

/**
 * Flies the camera along the route until the end, or until `stop()` is called.
 *
 * Args:
 *   map: map to drive; its camera is taken over for the duration.
 *   coords: route geometry with elevations, at least two points.
 *   onEnd: called once, when the flight finishes or is stopped.
 *
 * Returns:
 *   A handle to stop the flight early.
 */
export function startFlyover(map: MapLibreMap, coords: LonLatEle[], onEnd: () => void): FlyoverHandle {
  const dists = cumulativeDistancesM(coords);
  const totalM = dists[dists.length - 1];
  const speed = Math.min(MAX_SPEED_M_S, totalM / FLIGHT_SECONDS);
  const aheadM = Math.max(MIN_AHEAD_M, Math.min(MAX_AHEAD_M, totalM * AHEAD_FRACTION));
  const heightM = aheadM * HEIGHT_TO_AHEAD;

  // the pitch that comes out of the geometry runs past the default 60 degree cap
  const previousMaxPitch = map.getMaxPitch();
  map.setMaxPitch(85);

  let frame = 0;
  let done = false;
  let startedAt = 0;
  let altitude = positionAt(coords, dists, 0)[2] + heightM;

  // the camera rides the track itself; only the target runs ahead. Trailing the camera behind
  // the position instead would pin it to the start until the flight had covered that setback.
  const cameraFor = (travelledM: number) => {
    const camera = positionAt(coords, dists, travelledM);
    const target = positionAt(coords, dists, travelledM + aheadM);
    // clear the highest ground in the look-ahead window: on a climb the slope ahead rises above
    // a camera held over the current point, and the derived pitch tips towards the sky
    let ceiling = camera[2];
    for (let i = 1; i <= LOOKAHEAD_SAMPLES; i++) {
      const ahead = positionAt(coords, dists, travelledM + (aheadM * i) / LOOKAHEAD_SAMPLES);
      ceiling = Math.max(ceiling, ahead[2]);
    }
    const wanted = ceiling + heightM;
    altitude += (wanted - altitude) * ALTITUDE_SMOOTHING;
    return map.calculateCameraOptionsFromTo(
      new LngLat(camera[0], camera[1]),
      altitude,
      new LngLat(target[0], target[1]),
      target[2],
    );
  };

  let lastFrameAt = 0;
  const step = (now: number) => {
    if (done) return;
    if (!startedAt) startedAt = now;
    const travelled = ((now - startedAt) / 1000) * speed;
    if (now - lastFrameAt >= FRAME_INTERVAL_MS) {
      lastFrameAt = now;
      map.jumpTo(cameraFor(travelled));
    }
    if (travelled >= totalM) return finish();
    frame = requestAnimationFrame(step);
  };

  function takeOff() {
    if (done || startedAt) return;
    window.clearTimeout(takeOffFallback);
    frame = requestAnimationFrame(step);
  }

  function finish() {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    window.clearTimeout(takeOffFallback);
    map.off('idle', takeOff);
    map.setMaxPitch(previousMaxPitch);
    onEnd();
  }

  // frame the start and let its tiles arrive before moving: a flight that begins over a blank
  // map never catches up. Applied twice on purpose, the first jumpTo lands short when terrain
  // is on (maplibre-gl-js issue 4688).
  const start = cameraFor(0);
  map.jumpTo(start);
  map.jumpTo(start);
  map.once('idle', takeOff);
  const takeOffFallback = window.setTimeout(takeOff, TAKEOFF_TIMEOUT_MS);

  return { stop: finish };
}
