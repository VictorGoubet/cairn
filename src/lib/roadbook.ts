/**
 * The roadbook: the route as a table, point by point, the way it is carried in a pocket.
 *
 * Derived from the itinerary like the stages are, never stored. One row per point that means
 * something to whoever walks or runs it: the start, the finish, and every typed or named point in
 * between. A plain unnamed checkpoint is geometry, not a landmark, so it earns no row.
 *
 * Each row answers the four questions asked at a landmark: how far in, how much climbing done,
 * how much is left, and what time it should be. The times come from the same estimate the rest of
 * the app shows, so a roadbook never contradicts the summary above it.
 */

import type { Anchor, LegSlot } from '../store';
import { elevationStats, type LonLatEle } from './geo';
import { durationH, type HikerProfile } from './hikingTime';

export interface RoadbookRow {
  /** anchor index, so a row can be tied back to the map */
  anchorIndex: number;
  name: string;
  kind: Anchor['kind'];
  /** start and finish are positions, not kinds, and a roadbook says so */
  role: 'start' | 'finish' | 'point';
  elevation: number;
  /** cumulative from the start */
  distanceM: number;
  gainM: number;
  lossM: number;
  hours: number;
  /** since the previous row */
  legDistanceM: number;
  legGainM: number;
  legHours: number;
  /** clock time of the passage, when a departure was given */
  at: Date | null;
}

export interface Roadbook {
  rows: RoadbookRow[];
  distanceM: number;
  gainM: number;
  lossM: number;
  hours: number;
}

/**
 * Builds the roadbook of a route.
 *
 * Args:
 *   anchors: the route points.
 *   legs: the legs between them; one still routing contributes nothing yet.
 *   profile: the hiker or runner, for the durations.
 *   departure: when the day starts, for the clock column.
 */
export function buildRoadbook(
  anchors: Anchor[],
  legs: LegSlot[],
  profile: HikerProfile,
  departure?: Date | null,
): Roadbook {
  const rows: RoadbookRow[] = [];
  if (anchors.length === 0) return { rows, distanceM: 0, gainM: 0, lossM: 0, hours: 0 };

  let distanceM = 0;
  let gainM = 0;
  let lossM = 0;
  let hours = 0;
  let sinceRow = { distanceM: 0, gainM: 0, hours: 0 };

  anchors.forEach((anchor, index) => {
    if (index > 0) {
      const coords = legs[index - 1]?.leg?.coords ?? [];
      const stats = elevationStats(coords);
      const legDistance = legs[index - 1]?.leg?.distanceM ?? 0;
      const legHours = durationH(coords, profile);
      distanceM += legDistance;
      gainM += stats.gainM;
      lossM += stats.lossM;
      hours += legHours;
      sinceRow = {
        distanceM: sinceRow.distanceM + legDistance,
        gainM: sinceRow.gainM + stats.gainM,
        hours: sinceRow.hours + legHours,
      };
    }
    if (!isLandmark(anchor, index, anchors.length)) return;
    rows.push({
      anchorIndex: index,
      name: anchor.name,
      kind: anchor.kind,
      role: index === 0 ? 'start' : index === anchors.length - 1 ? 'finish' : 'point',
      elevation: elevationAt(legs, index),
      distanceM,
      gainM,
      lossM,
      hours,
      legDistanceM: sinceRow.distanceM,
      legGainM: sinceRow.gainM,
      legHours: sinceRow.hours,
      at: departure ? new Date(departure.getTime() + hours * 3_600_000) : null,
    });
    sinceRow = { distanceM: 0, gainM: 0, hours: 0 };
  });

  return { rows, distanceM, gainM, lossM, hours };
}

/** the ends always, and in between only what somebody bothered to type or to name */
function isLandmark(anchor: Anchor, index: number, count: number): boolean {
  return index === 0 || index === count - 1 || anchor.kind !== 'checkpoint' || anchor.name !== '';
}

/** the altitude of an anchor, read off the geometry that arrives there (or leaves it, at the start) */
function elevationAt(legs: LegSlot[], index: number): number {
  const before = legs[index - 1]?.leg?.coords;
  if (before && before.length > 0) return last(before)[2];
  const after = legs[index]?.leg?.coords;
  return after && after.length > 0 ? after[0][2] : 0;
}

function last(coords: LonLatEle[]): LonLatEle {
  return coords[coords.length - 1];
}
