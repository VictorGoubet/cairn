// Inserts a point into a route's existing geometry: the track is split at the nearest
// vertex, without any network re-routing. Shared between the store (insertion, POI
// right-click) and the migration of legacy local data.
import type { Anchor, LegSlot } from '../store';
import { haversineM, type LonLat, pathDistanceM } from './geo';

export interface SplicedRoute {
  anchors: Anchor[];
  legs: LegSlot[];
}

/**
 * Inserts `anchor` into the track at the vertex closest to `p`.
 *
 * Args:
 *   anchors: current route anchors.
 *   legs: current legs (a geometry is required to split).
 *   p: requested position; the anchor snaps onto the track, never beside it.
 *   anchor: anchor to insert, coordinates realigned on the selected vertex.
 *
 * Returns:
 *   The new anchors/legs lists, or null if no leg can be split.
 */
export function spliceIntoTrace(anchors: Anchor[], legs: LegSlot[], p: LonLat, anchor: Anchor): SplicedRoute | null {
  let bestLeg = -1;
  let bestCoord = -1;
  let bestDist = Number.POSITIVE_INFINITY;
  legs.forEach((slot, legIndex) => {
    const coords = slot.leg?.coords ?? [];
    coords.forEach((c, coordIndex) => {
      const d = haversineM([c[0], c[1]], p);
      if (d < bestDist) {
        bestDist = d;
        bestLeg = legIndex;
        bestCoord = coordIndex;
      }
    });
  });
  const leg = legs[bestLeg]?.leg;
  if (!leg) return null;
  // avoid a degenerate split at the leg endpoints
  const cut = Math.min(Math.max(bestCoord, 1), leg.coords.length - 2);
  if (cut < 1) return null;
  const snapped = leg.coords[cut];
  const manual = legs[bestLeg].manual;
  const beforeCoords = leg.coords.slice(0, cut + 1);
  const afterCoords = leg.coords.slice(cut);
  const before: LegSlot = {
    id: crypto.randomUUID(),
    manual,
    leg: { coords: beforeCoords, distanceM: pathDistanceM(beforeCoords) },
  };
  const after: LegSlot = {
    id: crypto.randomUUID(),
    manual,
    leg: { coords: afterCoords, distanceM: pathDistanceM(afterCoords) },
  };
  return {
    anchors: anchors.toSpliced(bestLeg + 1, 0, { ...anchor, lon: snapped[0], lat: snapped[1] }),
    legs: legs.flatMap((l, i) => (i === bestLeg ? [before, after] : [l])),
  };
}
