/**
 * Drone-like flight along the route, the way Strava plays an activity back.
 *
 * Built on the two-path technique Mapbox documents for camera paths: the camera rides one path
 * while a second point runs ahead of it, and both are sampled at the same progress. MapLibre has
 * no FreeCameraOptions, but `calculateCameraOptionsFromTo` does the same job: give it a camera
 * position with an altitude plus a target, and it derives center, zoom, pitch and bearing.
 * Letting geometry drive the camera beats animating pitch and zoom by hand.
 *
 * A hiking track is full of switchbacks and GPS wobble. Followed literally they shake the
 * camera, so the flight path is resampled at a constant step and averaged over a window: the
 * camera flies the shape of the route, not its every twitch. The heading is then smoothed once
 * more on the way out.
 *
 * The caller pins terrain exaggeration to 1 for the flight: MapLibre drops the closest tiles
 * when terrain is on, and the effect grows with exaggeration (maplibre-gl-js issue 1241),
 * which is what makes chunks of the map vanish mid-flight.
 */

import { LngLat, type Map as MapLibreMap } from 'maplibre-gl';
import { cumulativeDistancesM, type LonLatEle, nearestIndex } from './geo';

/** a full route plays in about this long, whatever its length */
const FLIGHT_SECONDS = 30;
/** ground speed cap: low and close needs a calmer pass than a high overview */
const MAX_SPEED_M_S = 90;
/**
 * How far ahead the camera looks, and how high it flies. Together they set the pitch and the
 * zoom MapLibre derives: measured at these latitudes, looking 1150 m ahead from 190 m up lands
 * near zoom 15.5 and pitch 81, which is the low grazing shot. Keeping the ratio holds that
 * framing on short routes too. Pitch flattens as soon as the height approaches the look-ahead,
 * and a much closer camera derives a zoom past 16.5, where tiles stop keeping up.
 */
const MAX_AHEAD_M = 1150;
const HEIGHT_TO_AHEAD = 190 / 1150;
/**
 * Short routes look ahead a fraction of their length, or the flight starts staring at the end.
 * The floor is what keeps a one kilometre route from deriving a zoom past 16.5: the look-ahead
 * sets the zoom, and 200 m of it framed a hedge.
 */
const AHEAD_FRACTION = 0.4;
const MIN_AHEAD_M = 700;
/** exponential smoothing on the camera altitude, so a cliff does not jerk the camera */
const ALTITUDE_SMOOTHING = 0.12;
/** hard floor on the drop onto the target while the smoothing catches up, as a share of height */
const MIN_DROP_RATIO = 0.8;
/** and on the heading, which is what the eye notices most */
const BEARING_SMOOTHING = 0.14;
/** samples over the look-ahead window, to clear the relief the camera is heading into */
const LOOKAHEAD_SAMPLES = 8;
/** flight path resampling step, and the averaging window that irons out switchbacks */
const RESAMPLE_STEP_M = 25;
const SMOOTHING_WINDOW_M = 150;
/** 30 frames per second is smooth enough here and halves the camera work of 60 */
const FRAME_INTERVAL_MS = 33;
/** terrain exaggeration during the flight, see the note above about vanishing tiles */
export const FLYOVER_EXAGGERATION = 1;
/**
 * Tiles are worth a short wait, but past this the flight starts anyway: pressing play and
 * watching nothing happen reads as broken.
 */
const TAKEOFF_TIMEOUT_MS = 1800;

export interface FlyoverHandle {
  stop(): void;
}

interface Path {
  coords: LonLatEle[];
  dists: number[];
}

function positionAt(path: Path, distanceM: number): LonLatEle {
  const { coords, dists } = path;
  const clamped = Math.min(Math.max(distanceM, 0), dists[dists.length - 1]);
  const i = Math.max(1, nearestIndex(dists, clamped));
  const span = dists[i] - dists[i - 1];
  const t = span > 0 ? Math.min(1, Math.max(0, (clamped - dists[i - 1]) / span)) : 0;
  const a = coords[i - 1];
  const b = coords[i];
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
}

/** shortest way around the circle, so the camera never spins the long way from 359 to 1 degree */
function shortestTurn(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/**
 * Resamples the track at a constant step, then averages each point over a window.
 *
 * Args:
 *   track: the route as walked, switchbacks included.
 *
 * Returns:
 *   A smooth path the camera can fly without shaking.
 */
function flightPath(track: Path): Path {
  const totalM = track.dists[track.dists.length - 1];
  const steps = Math.max(2, Math.round(totalM / RESAMPLE_STEP_M));
  const even: LonLatEle[] = Array.from({ length: steps + 1 }, (_, i) => positionAt(track, (totalM * i) / steps));

  const half = Math.max(1, Math.round(SMOOTHING_WINDOW_M / RESAMPLE_STEP_M / 2));
  const smoothed = even.map((point, i) => {
    const from = Math.max(0, i - half);
    const to = Math.min(even.length - 1, i + half);
    let lon = 0;
    let lat = 0;
    for (let j = from; j <= to; j++) {
      lon += even[j][0];
      lat += even[j][1];
    }
    const count = to - from + 1;
    // elevation stays as sampled: the camera clears the relief, it does not average it away
    return [lon / count, lat / count, point[2]] as LonLatEle;
  });

  return { coords: smoothed, dists: cumulativeDistancesM(smoothed) };
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
  const track: Path = { coords, dists: cumulativeDistancesM(coords) };
  const path = flightPath(track);
  const totalM = path.dists[path.dists.length - 1];
  const speed = Math.min(MAX_SPEED_M_S, totalM / FLIGHT_SECONDS);
  const aheadM = Math.max(MIN_AHEAD_M, Math.min(MAX_AHEAD_M, totalM * AHEAD_FRACTION));
  const heightM = aheadM * HEIGHT_TO_AHEAD;

  // the pitch that comes out of the geometry runs past the default 60 degree cap
  const previousMaxPitch = map.getMaxPitch();
  map.setMaxPitch(85);

  let frame = 0;
  let done = false;
  let startedAt = 0;
  let lastFrameAt = 0;
  let altitude = positionAt(path, 0)[2] + heightM;
  let bearing: number | null = null;

  // the camera rides the smoothed path; only the target runs ahead. Trailing the camera behind
  // the position instead would pin it to the start until the flight had covered that setback.
  const cameraFor = (travelledM: number) => {
    const camera = positionAt(path, travelledM);
    const target = positionAt(path, travelledM + aheadM);
    // clear the highest ground in the look-ahead window: on a climb the slope ahead rises above
    // a camera held over the current point, and the derived pitch tips towards the sky
    let ceiling = camera[2];
    for (let i = 1; i <= LOOKAHEAD_SAMPLES; i++) {
      ceiling = Math.max(ceiling, positionAt(track, travelledM + (aheadM * i) / LOOKAHEAD_SAMPLES)[2]);
    }
    // the height that matters is the drop onto the target, since that is what sets the pitch:
    // ahead / height. Referencing the ground under the camera instead let a climb catch up with
    // the smoothed altitude, and the camera ended up looking uphill at the sky.
    const wantedAltitude = Math.max(ceiling, target[2]) + heightM;
    altitude += (wantedAltitude - altitude) * ALTITUDE_SMOOTHING;
    altitude = Math.max(altitude, target[2] + heightM * MIN_DROP_RATIO);

    const options = map.calculateCameraOptionsFromTo(
      new LngLat(camera[0], camera[1]),
      altitude,
      new LngLat(target[0], target[1]),
      target[2],
    );
    const wanted = options.bearing ?? 0;
    bearing = bearing === null ? wanted : bearing + shortestTurn(bearing, wanted) * BEARING_SMOOTHING;
    return { ...options, bearing };
  };

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
