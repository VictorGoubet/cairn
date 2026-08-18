/**
 * Multi-day stages, derived from the route rather than stored: a stage is what lies between
 * two "camp / stage end" points. One camp splits a trek into two days, and removing it merges
 * them back, with nothing to migrate anywhere.
 */

import type { Anchor, LegSlot } from '../store';
import { elevationStats, type LonLatEle } from './geo';
import { durationH, energyKcal, type HikerProfile } from './hikingTime';

export interface Stage {
  /** anchor index range, inclusive on both ends */
  fromAnchor: number;
  toAnchor: number;
  /** name of the camp closing the stage, or '' for the last one */
  name: string;
  coords: LonLatEle[];
  distanceM: number;
  gainM: number;
  lossM: number;
  hours: number;
  kcal: number;
}

/**
 * Splits the route at its camp points.
 *
 * Args:
 *   anchors: route anchors, whose `camp` kind marks the end of a day.
 *   legs: the legs between them; a leg still computing contributes nothing yet.
 *   profile: the hiker, for durations and energy.
 *
 * Returns:
 *   One stage per day, or an empty list when the route has no camp in the middle
 *   (a single-day walk is not "a trek of one stage").
 */
export function computeStages(anchors: Anchor[], legs: LegSlot[], profile: HikerProfile): Stage[] {
  const cuts = anchors
    .map((a, i) => ({ a, i }))
    .filter(({ a, i }) => a.kind === 'camp' && i > 0 && i < anchors.length - 1);
  if (cuts.length === 0) return [];

  const bounds = [0, ...cuts.map(c => c.i), anchors.length - 1];
  const stages: Stage[] = [];
  for (let s = 0; s < bounds.length - 1; s++) {
    const fromAnchor = bounds[s];
    const toAnchor = bounds[s + 1];
    const coords: LonLatEle[] = [];
    for (let i = fromAnchor; i < toAnchor; i++) {
      const legCoords = legs[i]?.leg?.coords ?? [];
      coords.push(...(coords.length > 0 ? legCoords.slice(1) : legCoords));
    }
    const { gainM, lossM } = elevationStats(coords);
    stages.push({
      fromAnchor,
      toAnchor,
      name: anchors[toAnchor].name,
      coords,
      distanceM: legs.slice(fromAnchor, toAnchor).reduce((sum, l) => sum + (l.leg?.distanceM ?? 0), 0),
      gainM,
      lossM,
      hours: durationH(coords, profile),
      kcal: energyKcal(coords, profile),
    });
  }
  return stages;
}
