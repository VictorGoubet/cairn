// Insertion d'un point sur la géométrie existante d'un itinéraire: la trace est découpée
// au sommet le plus proche, sans recalcul réseau. Partagé entre le store (insertion,
// clic droit POI) et la migration des anciennes données locales.
import type { Anchor, LegSlot } from '../store';
import { haversineM, type LonLat, pathDistanceM } from './geo';

export interface SplicedRoute {
  anchors: Anchor[];
  legs: LegSlot[];
}

/**
 * Insère `anchor` dans le tracé au sommet le plus proche de `p`.
 *
 * Args:
 *   anchors: ancres actuelles de l'itinéraire.
 *   legs: tronçons actuels (une géométrie est requise pour découper).
 *   p: position demandée; l'ancre est aimantée sur la trace, jamais à côté.
 *   anchor: ancre à insérer, coordonnées recalées sur le sommet retenu.
 *
 * Returns:
 *   Les nouvelles listes anchors/legs, ou null si aucun tronçon n'est découpable.
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
  // pas de découpe dégénérée aux extrémités du tronçon
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
