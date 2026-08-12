/**
 * Drone-like flight along the route, the way Strava plays an activity back.
 *
 * Built on the two-path technique Mapbox documents for camera paths: the camera rides one path
 * while a glowing dot runs ahead of it on the route, and `calculateCameraOptionsFromTo` derives
 * center, zoom, pitch and bearing from that geometry (MapLibre has no FreeCameraOptions).
 * Letting geometry drive the camera beats animating pitch and zoom by hand.
 *
 * Smoothness is C2 by construction, not filtered after the fact. A hiking track is piecewise
 * linear: position is continuous but velocity jumps at every vertex, and the eye reads each
 * jump as a tremor. The camera therefore flies a uniform cubic B-spline over resampled,
 * window-averaged control points, which has continuous acceleration; its altitude comes from a
 * clearance envelope precomputed over the whole route and sampled through the same spline; and
 * ground speed follows a trapezoidal velocity profile, so the flight also starts and ends
 * without a jolt. Every frame is a pure function of elapsed time, with no filter state that
 * would behave differently at 60 fps and at 25.
 *
 * This module only drives the camera and the dot. The scene it flies through is the caller's
 * job (imagery, a coarser DEM, no markers and no labels), and terrain exaggeration is pinned
 * to 1 there: MapLibre drops the closest tiles when terrain is on, and the effect grows with
 * exaggeration (maplibre-gl-js issue 1241), which is what makes chunks of the map vanish
 * mid-flight.
 */

import { type GeoJSONSource, LngLat, type Map as MapLibreMap } from 'maplibre-gl';
import { cumulativeDistancesM, type LonLatEle, nearestIndex } from './geo';

/** short routes stretch to about this long, so a two kilometre loop is not over in a blink */
const FLIGHT_SECONDS = 20;
/**
 * Ground speed cap, and with it the playback time of a long route. It is bounded by tiles rather
 * than by taste: the imagery has to arrive before the camera gets there.
 */
const MAX_SPEED_M_S = 170;
/** speed ramps up and down over this long, the trapezoidal profile of motion control */
const RAMP_SECONDS = 2.5;
/**
 * How far ahead the camera looks, and how high it flies. Together they set the pitch and the
 * zoom MapLibre derives: measured at these latitudes, looking 1150 m ahead from 220 m up lands
 * near zoom 15.5 and pitch 79, which is the low grazing shot. Keeping the ratio holds that
 * framing on short routes too. Pitch flattens as soon as the height approaches the look-ahead,
 * and a much closer camera derives a zoom past 16.5, where tiles stop keeping up.
 */
const MAX_AHEAD_M = 1150;
const HEIGHT_TO_AHEAD = 220 / 1150;
/**
 * Short routes look ahead a fraction of their length, or the flight starts staring at the end.
 * The floor is what keeps a one kilometre route from deriving a zoom past 16.5: the look-ahead
 * sets the zoom, and 200 m of it framed a hedge.
 */
const AHEAD_FRACTION = 0.4;
const MIN_AHEAD_M = 700;
/** the camera parks this short of the finish, two coincident points derive no bearing */
const MIN_SEPARATION_M = 40;
/** flight path resampling step, and the averaging window that irons out switchbacks */
const RESAMPLE_STEP_M = 25;
const SMOOTHING_WINDOW_M = 150;
/** the clearance envelope is blurred this wide, a few times, and re-clamped onto the relief */
const ENVELOPE_BLUR_M = 300;
const ENVELOPE_PASSES = 3;
/** terrain exaggeration during the flight, see the note above about vanishing tiles */
export const FLYOVER_EXAGGERATION = 1;
/**
 * Tiles are worth a short wait, but past this the flight starts anyway: pressing play and
 * watching nothing happen reads as broken. The wait covers the scene switch too, since the
 * imagery the flight flies over is only requested when play is pressed.
 */
const TAKEOFF_TIMEOUT_MS = 3000;

const DOT_SOURCE = 'flyover-dot';
export const DOT_LAYERS = ['flyover-dot-glow', 'flyover-dot-core'] as const;

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
  const totalM = track.dists[track.dists.length - 1];
  const speed = Math.min(MAX_SPEED_M_S, totalM / FLIGHT_SECONDS);
  const aheadM = Math.max(MIN_AHEAD_M, Math.min(MAX_AHEAD_M, totalM * AHEAD_FRACTION));
  const heightM = aheadM * HEIGHT_TO_AHEAD;
  // chase distance in 3D; holding it also holds the zoom MapLibre derives from it
  const chaseM = Math.hypot(aheadM, heightM);
  const flight = buildFlight(track, aheadM, heightM);

  // the pitch that comes out of the geometry runs past the default 60 degree cap. The ceiling
  // stays under 85: that close to the horizon the near plane starts clipping the ground
  const previousMaxPitch = map.getMaxPitch();
  map.setMaxPitch(82);
  addDot(map);

  let frame = 0;
  let done = false;
  let startedAt = 0;

  // the whole frame is a pure function of the distance flown: the camera rides the spline while
  // the dot runs `aheadM` ahead on the real track, and the camera keeps looking at it
  const frameFor = (travelledM: number) => {
    const camDist = Math.min(travelledM, totalM - MIN_SEPARATION_M);
    const dotDist = Math.min(travelledM + aheadM, totalM);
    const camera = splineAt(flight.points, camDist);
    const target = splineAt(flight.points, dotDist);
    // near the finish the dot parks and the camera closes in; raising the camera to hold the 3D
    // chase distance keeps the zoom steady and turns the arrival into a pull-up over the finish
    const separationM = dotDist - camDist;
    const holdDropM = Math.sqrt(Math.max(chaseM * chaseM - separationM * separationM, heightM * heightM));
    const altitude = Math.max(scalarSplineAt(flight.clearance, camDist), target[2] + holdDropM);
    const options = map.calculateCameraOptionsFromTo(
      new LngLat(camera[0], camera[1]),
      altitude,
      new LngLat(target[0], target[1]),
      target[2],
    );
    return { options, dot: positionAt(track, dotDist) };
  };

  const step = (now: number) => {
    if (done) return;
    if (!startedAt) startedAt = now;
    const travelled = travelledAt((now - startedAt) / 1000, speed, totalM);
    const { options, dot } = frameFor(travelled);
    map.jumpTo(options);
    (map.getSource(DOT_SOURCE) as GeoJSONSource).setData(dotFeature(dot));
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
    removeDot(map);
    onEnd();
  }

  // frame the start and let its tiles arrive before moving: a flight that begins over a blank
  // map never catches up. Applied twice on purpose, the first jumpTo lands short when terrain
  // is on (maplibre-gl-js issue 4688).
  const start = frameFor(0);
  map.jumpTo(start.options);
  map.jumpTo(start.options);
  (map.getSource(DOT_SOURCE) as GeoJSONSource).setData(dotFeature(start.dot));
  map.once('idle', takeOff);
  const takeOffFallback = window.setTimeout(takeOff, TAKEOFF_TIMEOUT_MS);

  return { stop: finish };
}

interface Flight {
  /** B-spline control points every RESAMPLE_STEP_M, window-averaged */
  points: LonLatEle[];
  /** camera altitude clearing the relief ahead, one value per control point */
  clearance: number[];
}

/**
 * Precomputes the two curves a frame samples: the flight path and the clearance envelope.
 *
 * Args:
 *   track: the route as walked, switchbacks included.
 *   aheadM: look-ahead distance, also the window the envelope must clear.
 *   heightM: cruise height over the relief.
 *
 * Returns:
 *   Control points for `splineAt` / `scalarSplineAt`.
 */
function buildFlight(track: Path, aheadM: number, heightM: number): Flight {
  const totalM = track.dists[track.dists.length - 1];
  const steps = Math.max(2, Math.round(totalM / RESAMPLE_STEP_M));
  const even: LonLatEle[] = Array.from({ length: steps + 1 }, (_, i) => positionAt(track, (totalM * i) / steps));

  const half = Math.max(1, Math.round(SMOOTHING_WINDOW_M / RESAMPLE_STEP_M / 2));
  const points = even.map((_, i) => {
    const from = Math.max(0, i - half);
    const to = Math.min(even.length - 1, i + half);
    const sum = [0, 0, 0];
    for (let j = from; j <= to; j++) {
      sum[0] += even[j][0];
      sum[1] += even[j][1];
      sum[2] += even[j][2];
    }
    return sum.map(v => v / (to - from + 1)) as LonLatEle;
  });

  // required altitude: clear the highest raw relief inside the look-ahead window. A sliding max
  // has corners, so it is blurred wide and re-clamped onto the requirement a few times: the
  // result is a smooth envelope that never dips below the relief it must clear.
  const window = Math.max(1, Math.round(aheadM / RESAMPLE_STEP_M));
  const required = even.map((point, i) => {
    let ceiling = point[2];
    for (let j = i + 1; j <= Math.min(i + window, even.length - 1); j++) ceiling = Math.max(ceiling, even[j][2]);
    return ceiling + heightM;
  });
  let clearance = required;
  const blurHalf = Math.max(1, Math.round(ENVELOPE_BLUR_M / RESAMPLE_STEP_M / 2));
  for (let pass = 0; pass < ENVELOPE_PASSES; pass++) {
    clearance = clearance.map((_, i) => {
      const from = Math.max(0, i - blurHalf);
      const to = Math.min(clearance.length - 1, i + blurHalf);
      let sum = 0;
      for (let j = from; j <= to; j++) sum += clearance[j];
      return Math.max(sum / (to - from + 1), required[i]);
    });
  }

  return { points, clearance };
}

/**
 * Uniform cubic B-spline over control points spaced RESAMPLE_STEP_M apart.
 *
 * The spline approximates rather than interpolates, which is the point: it is C2 continuous,
 * so the camera's acceleration never jumps at a control point the way it does on a polyline.
 */
function splineAt(points: LonLatEle[], distanceM: number): LonLatEle {
  const { i, weights } = splineBasis(points.length, distanceM);
  const at = (k: number) => points[Math.min(Math.max(k, 0), points.length - 1)];
  const result: LonLatEle = [0, 0, 0];
  for (let j = 0; j < 4; j++) {
    const p = at(i - 1 + j);
    result[0] += p[0] * weights[j];
    result[1] += p[1] * weights[j];
    result[2] += p[2] * weights[j];
  }
  return result;
}

function scalarSplineAt(values: number[], distanceM: number): number {
  const { i, weights } = splineBasis(values.length, distanceM);
  const at = (k: number) => values[Math.min(Math.max(k, 0), values.length - 1)];
  return at(i - 1) * weights[0] + at(i) * weights[1] + at(i + 1) * weights[2] + at(i + 2) * weights[3];
}

function splineBasis(count: number, distanceM: number): { i: number; weights: [number, number, number, number] } {
  const u = Math.min(Math.max(distanceM / RESAMPLE_STEP_M, 0), count - 1);
  const i = Math.min(Math.floor(u), count - 2);
  const t = u - i;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    i,
    weights: [(1 - 3 * t + 3 * t2 - t3) / 6, (4 - 6 * t2 + 3 * t3) / 6, (1 + 3 * t + 3 * t2 - 3 * t3) / 6, t3 / 6],
  };
}

/**
 * Distance flown after `elapsedS`, on a trapezoidal velocity profile.
 *
 * Constant speed from a standing start is a velocity discontinuity, and the takeoff reads as a
 * jolt; ramping over RAMP_SECONDS at both ends is the standard motion-control fix.
 */
function travelledAt(elapsedS: number, speedM: number, totalM: number): number {
  const durationS = totalM / speedM + RAMP_SECONDS;
  if (elapsedS >= durationS) return totalM;
  if (elapsedS < RAMP_SECONDS) return (speedM * elapsedS * elapsedS) / (2 * RAMP_SECONDS);
  if (elapsedS > durationS - RAMP_SECONDS) {
    const remaining = durationS - elapsedS;
    return totalM - (speedM * remaining * remaining) / (2 * RAMP_SECONDS);
  }
  return speedM * (elapsedS - RAMP_SECONDS / 2);
}

/** the moving dot: a warm glow with a white core, riding the point the camera is looking at */
function addDot(map: MapLibreMap): void {
  if (map.getSource(DOT_SOURCE)) return;
  map.addSource(DOT_SOURCE, { type: 'geojson', data: dotFeature([0, 0, 0]) });
  map.addLayer({
    id: 'flyover-dot-glow',
    type: 'circle',
    source: DOT_SOURCE,
    paint: { 'circle-radius': 16, 'circle-color': '#ffb703', 'circle-blur': 1.1, 'circle-opacity': 0.9 },
  });
  map.addLayer({
    id: 'flyover-dot-core',
    type: 'circle',
    source: DOT_SOURCE,
    paint: {
      'circle-radius': 5.5,
      'circle-color': '#ffffff',
      'circle-stroke-color': '#f77f00',
      'circle-stroke-width': 2.5,
    },
  });
}

function removeDot(map: MapLibreMap): void {
  for (const layer of DOT_LAYERS) {
    if (map.getLayer(layer)) map.removeLayer(layer);
  }
  if (map.getSource(DOT_SOURCE)) map.removeSource(DOT_SOURCE);
}

function dotFeature(position: LonLatEle): GeoJSON.Feature<GeoJSON.Point> {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: [position[0], position[1]] },
  };
}
