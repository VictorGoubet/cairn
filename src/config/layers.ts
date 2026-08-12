const GEOPF_WMTS =
  'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

// SCAN 25 is served through the "private" endpoint with the historical public key ign_scan_ws
const GEOPF_WMTS_SCAN =
  'https://data.geopf.fr/private/wmts?apikey=ign_scan_ws&SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&STYLE=normal&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

// Plan IGN as vector tiles with the official style: sharp at any screen DPI
export const PLAN_IGN_STYLE_URL = 'https://data.geopf.fr/annexes/ressources/vectorTiles/styles/PLAN.IGN/standard.json';

// Global Terrarium DEM (Mapzen/AWS Open Data) for hillshading
export const TERRARIUM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

// fine-grained slope tiles computed client-side from the DEM (see lib/slopeTiles.ts)
export const SLOPES_TILES = 'slope://{z}/{x}/{y}';

// OSM waymarked trails (GR, PR) rendered by Waymarked Trails, like Komoot
export const GR_TILES = 'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png';

import type { MsgKey } from '../lib/i18n';

export interface RasterLayer {
  id: string;
  labelKey: MsgKey;
  tiles: string;
  maxzoom: number;
  attribution: string;
}

export const RASTER_BASE_LAYERS: RasterLayer[] = [
  {
    id: 'scan25',
    labelKey: 'layer_scan25',
    tiles: `${GEOPF_WMTS_SCAN}&LAYER=GEOGRAPHICALGRIDSYSTEMS.MAPS.SCAN25TOUR&FORMAT=image/jpeg`,
    maxzoom: 16,
    attribution: '© IGN / Géoplateforme',
  },
  {
    id: 'ortho',
    labelKey: 'layer_ortho',
    tiles: `${GEOPF_WMTS}&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&FORMAT=image/jpeg`,
    maxzoom: 19,
    attribution: '© IGN / Géoplateforme',
  },
  {
    id: 'osm',
    labelKey: 'layer_osm',
    tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxzoom: 19,
    attribution: '© OpenStreetMap contributors',
  },
];

export const BASE_LAYER_OPTIONS: { id: string; labelKey: MsgKey }[] = [
  { id: 'plan-ign', labelKey: 'layer_plan' },
  ...RASTER_BASE_LAYERS.map(l => ({ id: l.id, labelKey: l.labelKey })),
];

export const DEFAULT_BASE_LAYER = 'plan-ign';
export const FALLBACK_BASE_LAYER = 'scan25';
/** the flyover flies over imagery: at 200 m above the ground a drawn map has nothing to show */
export const FLYOVER_BASE_LAYER = 'ortho';

// fixed tile (massif des Bornes, z12) used as the thumbnail for base layers
const THUMB_TILE = { z: 12, x: 2117, y: 1458 };

export function layerThumbUrl(id: string): string {
  const template =
    id === 'plan-ign'
      ? `${GEOPF_WMTS}&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&FORMAT=image/png`
      : (RASTER_BASE_LAYERS.find(l => l.id === id)?.tiles ?? '');
  return template
    .replace('{z}', String(THUMB_TILE.z))
    .replace('{x}', String(THUMB_TILE.x))
    .replace('{y}', String(THUMB_TILE.y));
}
