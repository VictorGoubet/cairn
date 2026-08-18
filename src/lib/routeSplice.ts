// Inserts a point into a route's existing geometry: the track is split at the nearest
// vertex, without any network re-routing. Shared between the store (insertion, POI
// right-click) and the migration of legacy local data.
import type { Anchor, LegSlot } from '../store';
import { haversineM, type LonLat, type LonLatEle, pathDistanceM } from './geo';

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
  // the cut lands on the nearest *segment*, not on the nearest vertex. Snapping to a vertex
  // failed outright on a two-point leg (a beeline had no interior vertex to cut at) and, on a
  // sparse trace, dropped the point hundreds of metres from where it was clicked.
  let bestLeg = -1;
  let bestSegment = -1;
  let bestPoint: LonLatEle | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  legs.forEach((slot, legIndex) => {
    const coords = slot.leg?.coords ?? [];
    for (let i = 1; i < coords.length; i++) {
      const projected = projectOnSegment(p, coords[i - 1], coords[i]);
      const d = haversineM([projected[0], projected[1]], p);
      if (d < bestDist) {
        bestDist = d;
        bestLeg = legIndex;
        bestSegment = i;
        bestPoint = projected;
      }
    }
  });
  const leg = legs[bestLeg]?.leg;
  if (!leg || !bestPoint) return null;

  // reuse an existing vertex when the projection falls on one, so the geometry gains no
  // duplicate point
  const coords = leg.coords;
  const snapped: LonLatEle = bestPoint;
  const onPrevious = haversineM([coords[bestSegment - 1][0], coords[bestSegment - 1][1]], [snapped[0], snapped[1]]) < 1;
  const onNext = haversineM([coords[bestSegment][0], coords[bestSegment][1]], [snapped[0], snapped[1]]) < 1;
  const beforeCoords = onPrevious
    ? coords.slice(0, bestSegment)
    : onNext
      ? coords.slice(0, bestSegment + 1)
      : [...coords.slice(0, bestSegment), snapped];
  const afterCoords = onPrevious
    ? coords.slice(bestSegment - 1)
    : onNext
      ? coords.slice(bestSegment)
      : [snapped, ...coords.slice(bestSegment)];
  // a cut on an endpoint would leave an empty leg: the route already has an anchor there
  if (beforeCoords.length < 2 || afterCoords.length < 2) return null;

  const manual = legs[bestLeg].manual;
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

/**
 * Closest point of the segment [a, b] to `p`, with its interpolated elevation.
 *
 * Flat approximation, with the longitude scaled by the latitude: over a segment of a hiking
 * trace the error is centimetres, and it keeps the projection a few multiplications long.
 */
function projectOnSegment(p: LonLat, a: LonLatEle, b: LonLatEle): LonLatEle {
  const scale = Math.cos((a[1] * Math.PI) / 180);
  const ax = a[0] * scale;
  const bx = b[0] * scale;
  const px = p[0] * scale;
  const dx = bx - ax;
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
}
