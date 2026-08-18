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
 */

import { haversineM, type LonLatEle } from './geo';

export type HikerPace = 'strolling' | 'steady' | 'sporty' | 'athletic';

export interface HikerProfile {
  pace: HikerPace;
  /** body mass in kg, used by the energy estimate */
  weightKg: number;
  /** pack mass in kg: it slows the walker and costs energy */
  packKg: number;
}

export const DEFAULT_PROFILE: HikerProfile = { pace: 'steady', weightKg: 72, packKg: 8 };

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
  const tobler = 6 * Math.exp(-3.5 * Math.abs(clamped + 0.05));
  return (tobler * 1000 * paceFactor(profile)) / 3600;
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
 * Energy spent walking a track, in kcal.
 *
 * Pandolf et al. (1977) for the metabolic rate, with Santee's correction so that a descent
 * costs less than the flat rather than a negative amount.
 *
 * Args:
 *   coords: geometry with elevations.
 *   profile: the hiker, whose mass and pack drive the result.
 */
export function energyKcal(coords: LonLatEle[], profile: HikerProfile = DEFAULT_PROFILE): number {
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

function paceFactor(profile: HikerProfile): number {
  const loadRatio = profile.weightKg > 0 ? profile.packKg / profile.weightKg : 0;
  const loadFactor = Math.max(1 - LOAD_SPEED_PENALTY * loadRatio, MIN_LOAD_FACTOR);
  return PACE_FACTORS[profile.pace] * loadFactor;
}
