/**
 * The one map instance, shared by reference.
 *
 * There is exactly one map in the app, and panels living outside `MapView` need to read its
 * viewport (which routes are in view) or listen to its moves. Publishing the instance here
 * beats threading a ref through a context for a read-only need, and beats mirroring the
 * viewport into the store, where every pan would wake the draft writer up.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';

let current: MapLibreMap | null = null;

export function setMapInstance(map: MapLibreMap | null): void {
  current = map;
}

export function getMapInstance(): MapLibreMap | null {
  return current;
}
