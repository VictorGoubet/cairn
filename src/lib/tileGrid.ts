/**
 * Grille de tuiles Web-Mercator et cache de requêtes par cellule.
 *
 * Les overlays chargés à la volée (sentes OSM, refuges.info) découpent le viewport en
 * cellules alignées sur cette grille: une requête réseau par cellule, mémorisée pour la
 * session, pour rester léger sur les APIs bénévoles quel que soit le nombre d'utilisateurs.
 */

export interface ViewBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface Cell {
  x: number;
  y: number;
}

/**
 * Énumère les tuiles du niveau donné couvrant l'emprise.
 *
 * Args:
 *   bounds: emprise en degrés.
 *   zoom: niveau de la grille.
 */
export function cellsInBounds(bounds: ViewBounds, zoom: number): Cell[] {
  const n = 2 ** zoom;
  const toX = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const toY = (lat: number) => {
    const rad = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n);
  };
  const cells: Cell[] = [];
  for (let x = toX(bounds.west); x <= toX(bounds.east); x++) {
    for (let y = toY(bounds.north); y <= toY(bounds.south); y++) {
      cells.push({ x, y });
    }
  }
  return cells;
}

/**
 * Emprise géographique d'une tuile.
 *
 * Args:
 *   cell: coordonnées de la tuile.
 *   zoom: niveau de la grille.
 */
export function cellBounds(cell: Cell, zoom: number): ViewBounds {
  const n = 2 ** zoom;
  const lon = (x: number) => (x / n) * 360 - 180;
  const lat = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { west: lon(cell.x), east: lon(cell.x + 1), north: lat(cell.y), south: lat(cell.y + 1) };
}

/**
 * Récupération mémorisée avec éviction LRU; une entrée en erreur est retirée du cache.
 *
 * Args:
 *   cache: cache partagé du module appelant.
 *   key: clé de la cellule.
 *   maxSize: taille maximale du cache.
 *   fetcher: chargement effectif, appelé une seule fois par clé.
 */
export function cachedFetch<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  maxSize: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = fetcher().catch(err => {
    cache.delete(key);
    throw err;
  });
  cache.set(key, promise);
  if (cache.size > maxSize) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return promise;
}
