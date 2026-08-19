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
  // the world beyond the IGN coverage: a global topo, and the national maps of the neighbours
  {
    id: 'opentopo',
    labelKey: 'layer_opentopo',
    tiles: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    maxzoom: 16,
    attribution: '© OpenStreetMap contributors · © OpenTopoMap (CC-BY-SA)',
  },
  {
    id: 'swisstopo',
    labelKey: 'layer_swisstopo',
    tiles: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{z}/{x}/{y}.jpeg',
    maxzoom: 18,
    attribution: '© swisstopo',
  },
  {
    id: 'ngi-be',
    labelKey: 'layer_ngi_be',
    // cartoweb follows the WMTS row/col order: {z}/{y}/{x}
    tiles: 'https://cartoweb.wmts.ngi.be/1.0.0/topo/default/3857/{z}/{y}/{x}.png',
    maxzoom: 17,
    attribution: '© NGI/IGN Belgique',
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

// Plan IGN as raster: share images draw tiles on a canvas, where vector tiles have no place
export const PLAN_IGN_RASTER_TILES = `${GEOPF_WMTS}&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2&FORMAT=image/png`;
export const ORTHO_RASTER_TILES = `${GEOPF_WMTS}&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&FORMAT=image/jpeg`;

// fixed thumbnail tiles at z12: the French massif des Bornes, except for the national maps
// whose coverage stops at their border
const THUMB_TILE = { z: 12, x: 2117, y: 1458 };
const THUMB_TILE_BY_LAYER: Record<string, { z: number; x: number; y: number }> = {
  swisstopo: { z: 12, x: 2150, y: 1452 },
  'ngi-be': { z: 12, x: 2105, y: 1385 },
};

export function layerThumbUrl(id: string): string {
  const template = id === 'plan-ign' ? PLAN_IGN_RASTER_TILES : (RASTER_BASE_LAYERS.find(l => l.id === id)?.tiles ?? '');
  const tile = THUMB_TILE_BY_LAYER[id] ?? THUMB_TILE;
  return template.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
}
