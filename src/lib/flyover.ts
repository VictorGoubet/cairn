/**
 * Drone-like flight along the route, the way Strava plays an activity back.
 *
 * A glowing dot walks the whole route while the camera chases it, and
 * `calculateCameraOptionsFromTo` derives center, zoom, pitch and bearing from that geometry
 * (MapLibre has no FreeCameraOptions). Letting geometry drive the camera beats animating pitch
 * and zoom by hand. The dot accelerates and then holds a cruise ceiling, so a long route takes
 * longer to play rather than flying absurdly fast; the look-ahead (and with it the camera
 * height) follows the speed, which keeps the pass low and the imagery requested a constant few
 * seconds before the camera reaches it.
 *
 * Smoothness is C2 by construction, not filtered after the fact. A hiking track is piecewise
 * linear: position is continuous but velocity jumps at every vertex, and the eye reads each
 * jump as a tremor. The camera therefore flies a uniform cubic B-spline over resampled,
 * window-averaged control points, which has continuous acceleration; its altitude comes from a
 * clearance envelope precomputed over the whole route and sampled through the same spline; and
 * ground speed follows a trapezoidal velocity profile, so the flight also starts and ends
 * without a jolt. Every frame is a pure function of the dot's position, with no filter state
 * that would behave differently at 60 fps and at 25.
 *
 * The flight opens with the camera over the start, tilting from top-down to grazing as the dot
 * pulls ahead, then follows. Holding the 3D chase distance whenever the dot is closer than the
 * look-ahead is what keeps the derived zoom steady through that opening.
 *
 * The play view has two modes, switched by the caller through `setPaused`: auto, where the dot
 * advances on its own, and manual, where it holds still and follows scrub events from the
 * elevation profile. Resuming ramps the speed back up from zero, so it never jolts.
 *
 * This module only drives the camera, the dot and the crossing pulses. The scene it flies
 * through is the caller's job (imagery, a coarser DEM, no markers and no labels), and terrain
 * exaggeration is pinned to 1 there: MapLibre drops the closest tiles when terrain is on, and
 * the effect grows with exaggeration (maplibre-gl-js issue 1241), which is what makes chunks of
 * the map vanish mid-flight.
 */

import { type GeoJSONSource, LngLat, type Map as MapLibreMap } from 'maplibre-gl';
import { cumulativeDistancesM, type LonLatEle, nearestIndex } from './geo';
import { emitProgress, onScrub } from './routeProgress';

/** short routes still get a full flight: below this duration the speed scales down */
const FLIGHT_SECONDS = 10;
/**
 * Cruise ceiling. The flight accelerates and then holds this, the way Strava plays long
 * activities back: a long route takes longer rather than flying infinitely fast, which is what
 * keeps the camera low and the tiles loadable whatever the distance.
 */
const MAX_SPEED_M_S = 300;
/** speed ramps up and down over this long, the trapezoidal profile of motion control */
const RAMP_SECONDS = 2.5;
/**
 * Look-ahead and cruise height, tied by the ratio that frames the low grazing shot (measured:
 * 1150 m ahead from 220 m up lands near zoom 15.5 and pitch 79 at our latitudes). The look-ahead
 * follows the speed so the imagery ahead is always requested the same few seconds before the
 * camera reaches it; the floor keeps a short route from deriving a zoom past 16.5 (200 m of
 * look-ahead framed a hedge).
 */
const HEIGHT_TO_AHEAD = 220 / 1150;
const TILE_LEAD_S = 4;
const MIN_AHEAD_M = 700;
/** the dot keeps this lead over the camera park position, two coincident points derive no bearing */
const MIN_SEPARATION_M = 40;
/**
 * Path smoothing is temporal, not metric: the eye sees shake per second, so the averaging
 * window covers a fixed time of flight and grows with the ground speed. A 150 m window that
 * calmed a 90 m/s pass returns ten times the shake frequency at ten times the speed.
 */
const SMOOTHING_WINDOW_S = 1.8;
const MIN_SMOOTHING_WINDOW_M = 150;
/** control points per smoothing window, which keeps the spline cost independent of the speed */
const STEPS_PER_WINDOW = 6;
/** the clearance envelope is blurred over this much flight time, then re-clamped onto the relief */
const ENVELOPE_BLUR_S = 3;
const ENVELOPE_PASSES = 3;
/**
 * The relief window the camera must clear. Tying it to the look-ahead made long routes fly
 * needlessly high: clearing a peak three kilometres ahead only guards against the dot hiding
 * behind a ridge for a moment, and it costs the whole flight its closeness to the ground.
 */
const CLEARANCE_WINDOW_MAX_M = 1500;
/** terrain exaggeration during the flight, see the note above about vanishing tiles */
export const FLYOVER_EXAGGERATION = 1;
/**
 * Tiles are worth a short wait, but past this the flight starts anyway: pressing play and
 * watching nothing happen reads as broken. The wait covers the scene switch too, since the
 * imagery the flight flies over is only requested when play is pressed.
 */
const TAKEOFF_TIMEOUT_MS = 3000;
/** how long a crossing pulse and its label live on screen */
const PULSE_MS = 1400;
/**
 * Fast manual scrubbing lifts the camera: height is the honest answer to tiles that cannot
 * load at cursor speed, since one coarse tile covers what sixteen fine ones would. The boost
 * follows the dot speed beyond cruise and settles back down when the hand stops.
 */
const SCRUB_BOOST_S = 1.2;
const SCRUB_BOOST_MAX_M = 2500;
const SCRUB_BOOST_SMOOTHING_S = 0.4;

const DOT_SOURCE = 'flyover-dot';
const PULSE_SOURCE = 'flyover-pulse';
const DOT_LAYERS = ['flyover-pulse-ring', 'flyover-dot-glow', 'flyover-dot-core'] as const;

export interface FlyoverPoi {
  lon: number;
  lat: number;
  distM: number;
  /** shown when the dot crosses the point: its emoji and name */
  label: string;
}

export interface FlyoverHandle {
  stop(): void;
  /** true freezes the dot (manual mode); false resumes the flight from where it stands */
  setPaused(paused: boolean): void;
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
 *   pois: annotated points that pulse when the dot crosses them.
 *   onEnd: called once, when the flight finishes or is stopped.
 *
 * Returns:
 *   A handle to stop the flight early.
 */
export function startFlyover(
  map: MapLibreMap,
  coords: LonLatEle[],
  pois: FlyoverPoi[],
  onEnd: () => void,
): FlyoverHandle {
  const track: Path = { coords, dists: cumulativeDistancesM(coords) };
  const totalM = track.dists[track.dists.length - 1];
  const speed = Math.min(MAX_SPEED_M_S, totalM / FLIGHT_SECONDS);
  const aheadM = Math.max(MIN_AHEAD_M, speed * TILE_LEAD_S);
  const heightM = aheadM * HEIGHT_TO_AHEAD;
  // chase distance in 3D; holding it also holds the zoom MapLibre derives from it
  const chaseM = Math.hypot(aheadM, heightM);
  const flight = buildFlight(track, aheadM, heightM, speed);

  // the pitch that comes out of the geometry runs past the default 60 degree cap. The ceiling
  // stays under 85: that close to the horizon the near plane starts clipping the ground
  const previousMaxPitch = map.getMaxPitch();
  map.setMaxPitch(82);
  addLayers(map);

  const accel = speed / RAMP_SECONDS;
  let frame = 0;
  let done = false;
  let lastNow = 0;
  let paused = false;
  let progress = MIN_SEPARATION_M;
  let velocity = 0;
  let renderedDist: number | null = null;
  let scrubSpeed = 0;
  let boostM = 0;
  let pulses: { poi: FlyoverPoi; bornAt: number; label: HTMLDivElement }[] = [];

  // the whole frame is a pure function of the dot's position: the camera trails it by the
  // look-ahead, parked over the start while the dot pulls away, and keeps looking at it
  const frameFor = (dotDist: number) => {
    const camDist = Math.min(Math.max(dotDist - aheadM, 0), totalM - MIN_SEPARATION_M);
    const camera = splineAt(flight, camDist);
    const target = splineAt(flight, dotDist);
    // while the dot is closer than the look-ahead (the opening, or a scrub near the start),
    // raising the camera to hold the 3D chase distance keeps the derived zoom steady and tilts
    // the shot from top-down to grazing as the separation grows
    const separationM = dotDist - camDist;
    const holdDropM = Math.sqrt(Math.max(chaseM * chaseM - separationM * separationM, heightM * heightM));
    const altitude = Math.max(scalarSplineAt(flight, camDist), target[2] + holdDropM) + boostM;
    const options = map.calculateCameraOptionsFromTo(
      new LngLat(camera[0], camera[1]),
      altitude,
      new LngLat(target[0], target[1]),
      target[2],
    );
    return { options, dot: positionAt(track, dotDist) };
  };

  const renderAt = (dotDist: number, now: number) => {
    if (renderedDist !== null) {
      const from = Math.min(renderedDist, dotDist);
      const to = Math.max(renderedDist, dotDist);
      for (const poi of pois) {
        if (poi.distM > from && poi.distM <= to) pulses.push({ poi, bornAt: now, label: addPulseLabel(map, poi) });
      }
    }
    const hadPulses = pulses.length > 0;
    pulses = pulses.filter(p => {
      if (now - p.bornAt < PULSE_MS) return true;
      p.label.remove();
      return false;
    });
    if (dotDist !== renderedDist || boostM > 0) {
      const { options, dot } = frameFor(dotDist);
      map.jumpTo(options);
      (map.getSource(DOT_SOURCE) as GeoJSONSource).setData(dotFeature(dot));
      renderedDist = dotDist;
      emitProgress(dotDist);
    }
    if (hadPulses || pulses.length > 0) {
      // the labels are DOM, so they follow the camera by reprojection on every frame
      for (const p of pulses) {
        const at = map.project(new LngLat(p.poi.lon, p.poi.lat));
        p.label.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -180%)`;
      }
      (map.getSource(PULSE_SOURCE) as GeoJSONSource).setData({
        type: 'FeatureCollection',
        features: pulses.map(p => ({
          type: 'Feature',
          properties: { progress: (now - p.bornAt) / PULSE_MS },
          geometry: { type: 'Point', coordinates: [p.poi.lon, p.poi.lat] },
        })),
      });
    }
  };

  // the trapezoid is integrated rather than written in closed form, so the flight can pause
  // anywhere and ramp back up from there: accelerate to cruise, brake on the remaining distance
  const step = (now: number) => {
    if (done) return;
    // the cap only guards the return from a background tab, where rAF stops and dt is minutes;
    // a slow frame below it still advances by true clock time, or slow machines would fly slow
    const dt = lastNow ? Math.min((now - lastNow) / 1000, 0.5) : 0;
    lastNow = now;
    if (dt > 0) {
      const instant = Math.abs(progress - (renderedDist ?? progress)) / dt;
      scrubSpeed += (instant - scrubSpeed) * Math.min(dt / SCRUB_BOOST_SMOOTHING_S, 1);
      boostM = Math.min(Math.max(scrubSpeed - speed, 0) * SCRUB_BOOST_S, SCRUB_BOOST_MAX_M);
    }
    if (!paused) {
      const brake = Math.sqrt(2 * accel * Math.max(totalM - progress, 0));
      velocity = Math.max(Math.min(speed, velocity + accel * dt, brake), speed * 0.02);
      progress = Math.min(progress + velocity * dt, totalM);
    }
    renderAt(progress, now);
    if (!paused && progress >= totalM) return finish();
    frame = requestAnimationFrame(step);
  };

  // manual mode moves at the pointer's own speed: a click teleports, a drag follows the hand.
  // Tiles may flash white on a long jump, which beats waiting for a chaperoned glide.
  const offScrub = onScrub(distM => {
    progress = Math.min(Math.max(distM, MIN_SEPARATION_M), totalM);
    velocity = 0;
  });

  function takeOff() {
    if (done || lastNow) return;
    window.clearTimeout(takeOffFallback);
    frame = requestAnimationFrame(step);
  }

  function finish() {
    if (done) return;
    done = true;
    cancelAnimationFrame(frame);
    window.clearTimeout(takeOffFallback);
    offScrub();
    map.off('idle', takeOff);
    map.setMaxPitch(previousMaxPitch);
    for (const p of pulses) p.label.remove();
    pulses = [];
    removeLayers(map);
    onEnd();
  }

  // frame the start and let its tiles arrive before moving: a flight that begins over a blank
  // map never catches up. Applied twice on purpose, the first jumpTo lands short when terrain
  // is on (maplibre-gl-js issue 4688).
  const start = frameFor(MIN_SEPARATION_M);
  map.jumpTo(start.options);
  map.jumpTo(start.options);
  (map.getSource(DOT_SOURCE) as GeoJSONSource).setData(dotFeature(start.dot));
  map.once('idle', takeOff);
  const takeOffFallback = window.setTimeout(takeOff, TAKEOFF_TIMEOUT_MS);

  return {
    stop: finish,
    setPaused: p => {
      if (p === paused) return;
      paused = p;
      velocity = 0;
    },
  };
}

interface Flight {
  /** B-spline control points every `stepM`, window-averaged */
  points: LonLatEle[];
  /** camera altitude clearing the relief ahead, one value per control point */
  clearance: number[];
  /** spacing of the control points, derived from the smoothing window */
  stepM: number;
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
function buildFlight(track: Path, aheadM: number, heightM: number, speedM: number): Flight {
  const totalM = track.dists[track.dists.length - 1];
  const windowM = Math.max(MIN_SMOOTHING_WINDOW_M, speedM * SMOOTHING_WINDOW_S);
  const stepM = windowM / STEPS_PER_WINDOW;
  const steps = Math.max(2, Math.round(totalM / stepM));
  const even: LonLatEle[] = Array.from({ length: steps + 1 }, (_, i) => positionAt(track, (totalM * i) / steps));

  const half = Math.max(1, Math.round(windowM / stepM / 2));
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
  const lookaheadSteps = Math.max(1, Math.round(Math.min(aheadM, CLEARANCE_WINDOW_MAX_M) / stepM));
  const required = even.map((point, i) => {
    let ceiling = point[2];
    for (let j = i + 1; j <= Math.min(i + lookaheadSteps, even.length - 1); j++)
      ceiling = Math.max(ceiling, even[j][2]);
    return ceiling + heightM;
  });
  let clearance = required;
  const blurHalf = Math.max(1, Math.round((speedM * ENVELOPE_BLUR_S) / stepM / 2));
  for (let pass = 0; pass < ENVELOPE_PASSES; pass++) {
    clearance = clearance.map((_, i) => {
      const from = Math.max(0, i - blurHalf);
      const to = Math.min(clearance.length - 1, i + blurHalf);
      let sum = 0;
      for (let j = from; j <= to; j++) sum += clearance[j];
      return Math.max(sum / (to - from + 1), required[i]);
    });
  }

  return { points, clearance, stepM };
}

/**
 * Uniform cubic B-spline over the flight's control points.
 *
 * The spline approximates rather than interpolates, which is the point: it is C2 continuous,
 * so the camera's acceleration never jumps at a control point the way it does on a polyline.
 */
function splineAt(flight: Flight, distanceM: number): LonLatEle {
  const points = flight.points;
  const { i, weights } = splineBasis(points.length, distanceM / flight.stepM);
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

function scalarSplineAt(flight: Flight, distanceM: number): number {
  const values = flight.clearance;
  const { i, weights } = splineBasis(values.length, distanceM / flight.stepM);
  const at = (k: number) => values[Math.min(Math.max(k, 0), values.length - 1)];
  return at(i - 1) * weights[0] + at(i) * weights[1] + at(i + 1) * weights[2] + at(i + 2) * weights[3];
}

function splineBasis(count: number, position: number): { i: number; weights: [number, number, number, number] } {
  const u = Math.min(Math.max(position, 0), count - 1);
  const i = Math.min(Math.floor(u), count - 2);
  const t = u - i;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    i,
    weights: [(1 - 3 * t + 3 * t2 - t3) / 6, (4 - 6 * t2 + 3 * t3) / 6, (1 + 3 * t + 3 * t2 - 3 * t3) / 6, t3 / 6],
  };
}

/** the moving dot (warm glow, white core) and the expanding rings pulsed at crossed points */
function addLayers(map: MapLibreMap): void {
  if (map.getSource(DOT_SOURCE)) return;
  map.addSource(DOT_SOURCE, { type: 'geojson', data: dotFeature([0, 0, 0]) });
  map.addSource(PULSE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'flyover-pulse-ring',
    type: 'circle',
    source: PULSE_SOURCE,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'progress'], 0, 6, 1, 38],
      'circle-color': '#ffb703',
      'circle-opacity': ['interpolate', ['linear'], ['get', 'progress'], 0, 0.35, 1, 0],
      'circle-stroke-color': '#ffb703',
      'circle-stroke-width': 2.5,
      'circle-stroke-opacity': ['interpolate', ['linear'], ['get', 'progress'], 0, 0.95, 1, 0],
    },
  });
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

function addPulseLabel(map: MapLibreMap, poi: FlyoverPoi): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'flyover-poi-label';
  el.textContent = poi.label;
  map.getContainer().appendChild(el);
  return el;
}

function removeLayers(map: MapLibreMap): void {
  for (const layer of DOT_LAYERS) {
    if (map.getLayer(layer)) map.removeLayer(layer);
  }
  for (const source of [DOT_SOURCE, PULSE_SOURCE]) {
    if (map.getSource(source)) map.removeSource(source);
  }
}

function dotFeature(position: LonLatEle): GeoJSON.Feature<GeoJSON.Point> {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Point', coordinates: [position[0], position[1]] },
  };
}
