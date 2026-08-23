/**
 * How long a hike takes, and what it costs in energy.
 *
 * The literature offers two families. The linear rules add a penalty per metre climbed:
 * Naismith (1892, 5 km/h + 1 h per 600 m of ascent), the Swiss Alpine Club scale (4.2 km/h,
 * 400 m/h up, 800 m/h down), DIN 33466 (4 km/h, 300 m up, 500 m down). They are easy but blind
 * to steepness: 500 m of descent counts the same whether it is a gentle track or a scree
 * couloir, and they miss what Langmuir added to Naismith by hand, that a gentle descent is
 * *faster* than the flat.
 *
 * The other family models speed as a function of slope, segment by segment. Tobler's hiking
 * function (1993, from Imhof's Swiss marching data) is the reference:
 *
 *     speed = 6 km/h * exp(-3.5 * |slope + 0.05|)
 *
 * peaking at -5% slope, which is exactly the gentle-descent effect. That is the model used
 * here, on the geometry the router already returns, scaled by one personal pace factor.
 *
 * Tobler is known to overestimate peak rates (Irmischer & Clarke, 2018), and its 5.0 km/h on the
 * flat is a walker with empty hands. The calibration point is therefore the *default profile,
 * pack included*: the SAC scale describes a hiker carrying a day pack, so `steady` with 8 kg on
 * 72 kg must come out at 4.2 km/h on the flat. It then climbs a 20% slope at 418 m/h (SAC: 400)
 * and descends it at 593 m/h (DIN 33466: 500, SAC: 800). Tobler's shape, the SAC's calibration.
 *
 * Energy is a separate question, and the one where body mass genuinely belongs: the Pandolf
 * equation (1977) predicts the metabolic rate from mass, load, speed and grade. Pace, not sex or
 * age, is what the literature ties to hiking speed, so the profile keeps them apart.
 *
 * A hiker who has measured themselves gets the linear family instead, which is what those three
 * numbers are: `custom` prices a segment as its horizontal distance over the flat speed, plus its
 * climb over the ascent rate, plus its descent over the descent rate. Naismith with your own
 * figures, and the reason it is offered: the estimate is then verifiable by hand, which no fitted
 * curve is. It costs what every linear rule costs, being blind to steepness within each term, and
 * it adds the terms rather than taking the dominant one, so a climb spread over kilometres is
 * priced above the same climb taken straight up.
 *
 * **Running is not walking scaled up**, so it gets its own model rather than a bigger pace
 * factor. Minetti et al. (2002) measured the energy cost of walking and of running from -45% to
 * +45% of gradient, in joules per kilogram per metre. At a sustained power, speed is that power
 * divided by the cost, which gives two speeds at every gradient: one running, one walking. Take
 * the faster and the trail runner's own behaviour falls out of the physics: on the flat running
 * wins easily, and somewhere around a quarter of gradient walking takes over, because walking is
 * the cheaper gait uphill. Two ceilings keep the curve honest, since neither gait is limited by
 * energy alone: nobody walks faster than about 6.5 km/h without race technique, and a descent is
 * limited by braking and footing rather than by breath, more so the steeper it gets. That second
 * ceiling is a shape, not a measurement: it says a fast runner descends faster than a slow one
 * and that steep ground costs speed, which is what a trail runner recognises, and it makes no
 * claim about how technical the ground actually is.
 */

import { haversineM, type LonLatEle } from './geo';

export type HikerPace = 'strolling' | 'steady' | 'sporty' | 'athletic';
/** on foot, but a hiker, a trail runner and a self-measured walker obey three different models */
export type TravelMode = 'hike' | 'run' | 'custom';

export interface HikerProfile {
  mode: TravelMode;
  /** ignored in `custom` mode, where the three rates below say everything */
  pace: HikerPace;
  /** body mass in kg, used by the energy estimate */
  weightKg: number;
  /** pack mass in kg: it slows the walker and costs energy */
  packKg: number;
  /** custom mode: km/h held on flat ground */
  flatKmh: number;
  /** custom mode: metres of ascent per hour */
  ascentMH: number;
  /** custom mode: metres of descent per hour */
  descentMH: number;
}

export const DEFAULT_PROFILE: HikerProfile = {
  mode: 'hike',
  pace: 'steady',
  weightKg: 72,
  packKg: 8,
  // the Swiss Alpine Club scale, so switching to custom starts where the default hiker already was
  flatKmh: 4.2,
  ascentMH: 400,
  descentMH: 800,
};

/**
 * Pace factors applied to Tobler's speed.
 *
 * `steady` is the calibration point: with the default 8 kg pack it puts the flat at 4.2 km/h.
 * The others are the spread hiking guides describe, roughly 3.4 to 5.7 km/h on the flat, between
 * a stroller and a mountain athlete; a measured population would be a study, not a constant.
 */
const PACE_FACTORS: Record<HikerPace, number> = {
  strolling: 0.75,
  steady: 0.94,
  sporty: 1.12,
  athletic: 1.28,
};

/**
 * Flat trail speed of a runner, in km/h, one per pace.
 *
 * This is the calibration point of the running model, the way `steady` is for walking: everything
 * else follows from the cost curves. Read it as the speed held on a flat trail, not on a track.
 */
const RUN_FLAT_KMH: Record<HikerPace, number> = {
  strolling: 8.5,
  steady: 10.5,
  sporty: 12.5,
  athletic: 15,
};

/** the gradient range Minetti measured: beyond it the polynomials are extrapolation, not data */
const MAX_MINETTI_SLOPE = 0.45;
/** fast hiking, above which walking needs race technique nobody uses on a trail */
const WALK_CEILING_MS = 6.5 / 3.6;
/** and nobody power-hikes near their own running speed: the ceiling follows the athlete too */
const WALK_SHARE = 0.62;
/** how much faster than the flat a runner descends when the slope does the work */
const DESCENT_GAIN = 1.3;
/** below this the descent is free; past it braking and footing take the speed back */
const FREE_DESCENT = 0.1;
/** how fast that ceiling closes with steepness: a shape a runner recognises, not a measurement */
const BRAKING = 3;

/** a pack costs speed too: ~1% per 1% of body mass carried, the load-carriage rule of thumb */
const LOAD_SPEED_PENALTY = 1;
/** never let a heavy pack drive the estimate below a crawl */
const MIN_LOAD_FACTOR = 0.7;
/** Pandolf terrain factor: 1.0 is a road, 1.2 a dirt path, 1.5 heavy going */
const TERRAIN_FACTOR = 1.2;
/** kcal per kJ */
const KCAL_PER_KJ = 0.239;
/** steepest slope fed to Tobler: beyond ~40° nobody walks, and a bad elevation point (a DEM
 * seam, a bogus <ele> in a GPX) must cost minutes, not millions of hours */
const MAX_SLOPE = 0.8;

/**
 * Walking speed on a given slope, in m/s.
 *
 * Args:
 *   slope: rise over run, negative downhill.
 *   profile: the hiker.
 */
export function speedMs(slope: number, profile: HikerProfile): number {
  const clamped = Math.max(-MAX_SLOPE, Math.min(MAX_SLOPE, slope));
  if (profile.mode === 'custom') return customSpeedMs(clamped, profile);
  if (profile.mode === 'run') return runStep(clamped, profile).speedMs;
  const tobler = 6 * Math.exp(-3.5 * Math.abs(clamped + 0.05));
  return (tobler * 1000 * paceFactor(profile)) / 3600;
}

/**
 * Energy cost of a gait on a gradient, in J/kg/m (Minetti et al., 2002).
 *
 * Args:
 *   slope: rise over run, negative downhill.
 *   gait: which of the two curves.
 */
export function gaitCost(slope: number, gait: 'walk' | 'run'): number {
  const i = Math.max(-MAX_MINETTI_SLOPE, Math.min(MAX_MINETTI_SLOPE, slope));
  return gait === 'run'
    ? 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6
    : 280.5 * i ** 5 - 58.7 * i ** 4 - 76.8 * i ** 3 + 51.9 * i ** 2 + 19.6 * i + 2.5;
}

/**
 * Time to walk a track, in hours, summed segment by segment.
 *
 * Args:
 *   coords: geometry with elevations.
 *   profile: the hiker.
 */
export function durationH(coords: LonLatEle[], profile: HikerProfile = DEFAULT_PROFILE): number {
  let seconds = 0;
  for (let i = 1; i < coords.length; i++) {
    const runM = haversineM([coords[i - 1][0], coords[i - 1][1]], [coords[i][0], coords[i][1]]);
    if (runM < 0.5) continue;
    const slope = (coords[i][2] - coords[i - 1][2]) / runM;
    // the 3D length: on a 40% slope the walked distance is 8% longer than the map distance
    const walkedM = Math.hypot(runM, coords[i][2] - coords[i - 1][2]);
    seconds += walkedM / speedMs(slope, profile);
  }
  return seconds / 3600;
}

/**
 * Energy spent covering a track, in kcal.
 *
 * Walking: Pandolf et al. (1977) for the metabolic rate, with Santee's correction so that a
 * descent costs less than the flat rather than a negative amount. Running gets the Minetti cost
 * of the gait actually used at that gradient, since Pandolf is a load-carriage walking equation
 * and says nothing about running.
 *
 * Args:
 *   coords: geometry with elevations.
 *   profile: the hiker, whose mass and pack drive the result.
 */
export function energyKcal(coords: LonLatEle[], profile: HikerProfile = DEFAULT_PROFILE): number {
  if (profile.mode === 'run') return runEnergyKcal(coords, profile);
  const mass = profile.weightKg;
  const load = profile.packKg;
  let joules = 0;
  for (let i = 1; i < coords.length; i++) {
    const runM = haversineM([coords[i - 1][0], coords[i - 1][1]], [coords[i][0], coords[i][1]]);
    if (runM < 0.5) continue;
    const slope = (coords[i][2] - coords[i - 1][2]) / runM;
    const speed = speedMs(slope, profile);
    const grade = slope * 100;
    const standing = 1.5 * mass + 2.0 * (mass + load) * (load / mass) ** 2;
    const moving = TERRAIN_FACTOR * (mass + load) * (1.5 * speed ** 2 + 0.35 * speed * grade);
    // downhill: the correction keeps the rate above resting instead of going negative
    const correction =
      grade < 0
        ? -TERRAIN_FACTOR *
          ((grade * (mass + load) * speed ** 2) / 3.5 - ((mass + load) * (grade + 6) ** 2) / mass + 25 * speed ** 2)
        : 0;
    const watts = Math.max(standing + moving - correction, 1.5 * mass);
    const walkedM = Math.hypot(runM, coords[i][2] - coords[i - 1][2]);
    joules += watts * (walkedM / speed);
  }
  return (joules / 1000) * KCAL_PER_KJ;
}

/** the cost of the gait the runner would actually use, plus what the body burns just standing */
function runEnergyKcal(coords: LonLatEle[], profile: HikerProfile): number {
  const mass = profile.weightKg + profile.packKg;
  let joules = 0;
  for (let i = 1; i < coords.length; i++) {
    const runM = haversineM([coords[i - 1][0], coords[i - 1][1]], [coords[i][0], coords[i][1]]);
    if (runM < 0.5) continue;
    const rise = coords[i][2] - coords[i - 1][2];
    const slope = rise / runM;
    const coveredM = Math.hypot(runM, rise);
    const step = runStep(slope, profile);
    joules += step.costJPerKgM * mass * coveredM + 1.5 * profile.weightKg * (coveredM / step.speedMs);
  }
  return (joules / 1000) * KCAL_PER_KJ;
}

/**
 * The hiker's own three rates, as a speed along the ground.
 *
 * The linear rule prices one horizontal metre at `1 / flat + climb / ascent + drop / descent`
 * seconds; the speed along the path is then the 3D length of that metre over the same time. On the
 * flat it is exactly the typed speed, and on a climb steep enough that the horizontal term
 * vanishes, exactly the typed ascent rate.
 */
function customSpeedMs(slope: number, profile: HikerProfile): number {
  const flat = Math.max(0.2, profile.flatKmh) / 3.6;
  const up = Math.max(20, profile.ascentMH) / 3600;
  const down = Math.max(20, profile.descentMH) / 3600;
  const secondsPerHorizontalM = 1 / flat + Math.max(slope, 0) / up + Math.max(-slope, 0) / down;
  return Math.hypot(1, slope) / secondsPerHorizontalM;
}

/**
 * What a trail runner does on that gradient: the faster gait, under both ceilings.
 *
 * Speed and cost come out together on purpose. Deciding the gait on the cost alone would answer
 * "walk" everywhere, since walking is the cheaper gait per metre even on the flat; it is the
 * ceilings that make running the faster choice, so the energy estimate has to follow the gait the
 * speed actually picked.
 */
function runStep(slope: number, profile: HikerProfile): { speedMs: number; costJPerKgM: number } {
  const flat = (RUN_FLAT_KMH[profile.pace] * 1000) / 3600;
  const power = flat * gaitCost(0, 'run');
  const running = power / gaitCost(slope, 'run');
  const walking = Math.min(power / gaitCost(slope, 'walk'), WALK_CEILING_MS, flat * WALK_SHARE);
  const gait = walking > running ? 'walk' : 'run';
  const speed = Math.min(Math.max(running, walking), descentCeilingMs(flat, slope)) * loadFactor(profile);
  return { speedMs: speed, costJPerKgM: gaitCost(slope, gait) };
}

/** uphill and on the flat this is inert; downhill it is what actually limits the pace */
function descentCeilingMs(flatMs: number, slope: number): number {
  const steepness = Math.max(0, -slope - FREE_DESCENT);
  return (flatMs * DESCENT_GAIN) / (1 + BRAKING * steepness);
}

function paceFactor(profile: HikerProfile): number {
  return PACE_FACTORS[profile.pace] * loadFactor(profile);
}

function loadFactor(profile: HikerProfile): number {
  const loadRatio = profile.weightKg > 0 ? profile.packKg / profile.weightKg : 0;
  return Math.max(1 - LOAD_SPEED_PENALTY * loadRatio, MIN_LOAD_FACTOR);
}
