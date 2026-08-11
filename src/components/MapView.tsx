import type { GeoJSONSource, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import {
  GeolocateControl,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  Popup,
  ScaleControl,
  setWorkerUrl,
} from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { useEffect, useRef, useState } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  FALLBACK_BASE_LAYER,
  GR_TILES,
  PLAN_IGN_STYLE_URL,
  RASTER_BASE_LAYERS,
  SLOPES_TILES,
  TERRARIUM_TILES,
} from '../config/layers';
import { cumulativeDistancesM, kmMarkerPoints } from '../lib/geo';
import { fetchHiddenTrails, HIDDEN_TRAILS_MIN_ZOOM } from '../lib/hiddenTrails';
import { tNow } from '../lib/i18n';
import { kindDef, type PointKind } from '../lib/points';
import {
  fetchRefugePoints,
  REFUGE_CATEGORY_COLORS,
  REFUGE_CATEGORY_EMOJI,
  REFUGES_ATTRIBUTION,
  REFUGES_MIN_ZOOM,
  type RefugeCategory,
} from '../lib/refugesInfo';
import { registerSlopeProtocol } from '../lib/slopeTiles';
import { SURFACE_COLORS, type SurfaceCategory, WAY_COLORS, type WayCategory } from '../lib/waytypes';
import { routeCoords, usePlanner } from '../store';

// cadence standard de recalcul pendant un drag (cf. routeDragInterval de Leaflet Routing Machine)
const DRAG_REROUTE_MS = 450;
const CONTOUR_SOURCE_LAYER = 'oro_courbe';

// exagération du terrain 3D adaptée au relief visible: règle cartographique classique (Imhof),
// la plaine a besoin de 2-3x pour se lire, la haute montagne est déjà spectaculaire vers 1x
const TERRAIN_EXAGGERATION_MIN = 1.1;
const TERRAIN_EXAGGERATION_MAX = 3;
/** le relief visible doit occuper environ cette fraction de la largeur du viewport */
const TERRAIN_RELIEF_TARGET = 0.05;
/** en dessous de cet écart, on garde l'exagération en place (évite les à-coups) */
const TERRAIN_EXAGGERATION_STEP = 0.25;

// une fois bundlé, maplibre ne sait plus localiser son worker (import relatif vers
// maplibre-gl-shared.mjs): on fait bundler le worker par Vite et on fournit son URL
setWorkerUrl(maplibreWorkerUrl);

registerSlopeProtocol();

const ROUTE_SOURCE = 'route';
const DRAG_SOURCE = 'drag-line';
const HIGHLIGHT_SOURCE = 'waytype-highlight';
const HIDDEN_TRAILS_SOURCE = 'hidden-trails';
const REFUGES_SOURCE = 'refuge-points';
const EMPTY_ROUTE: GeoJSON.GeoJSON = { type: 'FeatureCollection', features: [] };

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const vectorLayersRef = useRef<{ id: string; type: string; isContour: boolean; visible: boolean }[]>([]);
  const anchorMarkersRef = useRef<Marker[]>([]);
  const offRouteMarkersRef = useRef<Marker[]>([]);
  const kmMarkersRef = useRef<Marker[]>([]);
  const hoverMarkerRef = useRef<Marker | null>(null);
  const terrainExagRef = useRef(TERRAIN_EXAGGERATION_MIN);
  const [mapReady, setMapReady] = useState(false);

  const lang = usePlanner(s => s.lang);
  const baseLayerId = usePlanner(s => s.baseLayerId);
  const overlays = usePlanner(s => s.overlays);
  const anchors = usePlanner(s => s.anchors);
  const legs = usePlanner(s => s.legs);
  const offRoutePoints = usePlanner(s => s.offRoutePoints);
  const hoverPoint = usePlanner(s => s.hoverPoint);
  const flyTo = usePlanner(s => s.flyTo);
  const wayTypeHighlight = usePlanner(s => s.wayTypeHighlight);

  useEffect(() => {
    let cancelled = false;
    let map: MapLibreMap | null = null;
    buildStyle().then(bundle => {
      if (cancelled || !containerRef.current) return;
      vectorLayersRef.current = bundle.vectorLayers;
      if (bundle.vectorLayers.length === 0) usePlanner.getState().setBaseLayerId(FALLBACK_BASE_LAYER);
      map = new MapLibreMap({
        container: containerRef.current,
        style: bundle.style,
        center: [2.4, 46.6],
        zoom: 5.5,
        maxZoom: 19,
      });
      if (import.meta.env.DEV) (window as unknown as { __map: MapLibreMap }).__map = map;
      map.addControl(new NavigationControl({ visualizePitch: true }));
      map.addControl(new GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }));
      map.addControl(new ScaleControl());
      map.on('load', () => {
        if (!map) return;
        map.addSource(ROUTE_SOURCE, { type: 'geojson', data: EMPTY_ROUTE });
        map.addLayer({
          id: 'route-casing',
          type: 'line',
          source: ROUTE_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#ffffff', 'line-width': 7 },
        });
        map.addLayer({
          id: 'route-line',
          type: 'line',
          source: ROUTE_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#e34948', 'line-width': 4 },
        });
        // surbrillance des segments correspondant à la légende survolée (types de voies, surfaces)
        map.addSource(HIGHLIGHT_SOURCE, { type: 'geojson', data: EMPTY_ROUTE });
        map.addLayer({
          id: 'waytype-highlight',
          type: 'line',
          source: HIGHLIGHT_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#2f9e44', 'line-width': 7, 'line-opacity': 0.95 },
        });
        // sentes discrètes OSM + points refuges.info, chargés à la volée par cellule (voir tileGrid)
        map.addSource(HIDDEN_TRAILS_SOURCE, { type: 'geojson', data: EMPTY_ROUTE });
        map.addLayer(
          {
            id: 'overlay-hidden',
            type: 'line',
            source: HIDDEN_TRAILS_SOURCE,
            layout: { 'line-cap': 'round', visibility: 'none' },
            paint: { 'line-color': '#9c36b5', 'line-width': 1.8, 'line-dasharray': [2, 2], 'line-opacity': 0.9 },
          },
          'route-casing',
        );
        map.addSource(REFUGES_SOURCE, { type: 'geojson', data: EMPTY_ROUTE, attribution: REFUGES_ATTRIBUTION });
        for (const cat of Object.keys(REFUGE_CATEGORY_EMOJI) as RefugeCategory[]) {
          map.addImage(`refuge-${cat}`, refugeBadgeImage(cat), { pixelRatio: 2 });
        }
        map.addLayer({
          id: 'overlay-refuges',
          type: 'symbol',
          source: REFUGES_SOURCE,
          layout: {
            visibility: 'none',
            'icon-image': ['concat', 'refuge-', ['get', 'cat']],
            'icon-allow-overlap': true,
          },
        });
        map.on('click', 'overlay-refuges', e => {
          e.preventDefault();
          const feature = e.features?.[0];
          if (!feature) return;
          new Popup({ offset: 10, maxWidth: '260px' })
            .setLngLat(e.lngLat)
            .setDOMContent(refugePopupContent(feature.properties as Record<string, unknown>))
            .addTo(map as MapLibreMap);
        });
        map.on('mouseenter', 'overlay-refuges', () => {
          if (map) map.getCanvas().style.cursor = 'pointer';
        });
        map.on('mouseleave', 'overlay-refuges', () => {
          if (map) map.getCanvas().style.cursor = 'crosshair';
        });
        // ligne élastique voisin → curseur → voisin, seule à suivre la souris pendant un drag
        map.addSource(DRAG_SOURCE, { type: 'geojson', data: EMPTY_ROUTE });
        map.addLayer({
          id: 'drag-line',
          type: 'line',
          source: DRAG_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#e34948', 'line-width': 2.5, 'line-opacity': 0.85, 'line-dasharray': [1, 2] },
        });

        // curseur par défaut = poser un point; sur la trace = insérer
        map.getCanvas().style.cursor = 'crosshair';
        // le clic sur la trace insère un point dans le bon tronçon, sans en ajouter à la fin
        map.on('click', 'route-line', e => {
          e.preventDefault();
          usePlanner.getState().insertAnchor([e.lngLat.lng, e.lngLat.lat]);
        });
        map.on('mouseenter', 'route-line', () => {
          if (map) map.getCanvas().style.cursor = 'copy';
        });
        map.on('mouseleave', 'route-line', () => {
          if (map) map.getCanvas().style.cursor = 'crosshair';
        });
        map.on('click', e => {
          if (!e.defaultPrevented) usePlanner.getState().addAnchor([e.lngLat.lng, e.lngLat.lat]);
        });
        map.on('contextmenu', e => {
          usePlanner.getState().addOffRoutePoint([e.lngLat.lng, e.lngLat.lat]);
        });
        setMapReady(true);
      });
      mapRef.current = map;
      if (import.meta.env.DEV) {
        Object.assign(window, { __map: map, __planner: usePlanner });
      }
    });
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
      setMapReady(false);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    for (const layer of RASTER_BASE_LAYERS) {
      map.setLayoutProperty(layer.id, 'visibility', layer.id === baseLayerId ? 'visible' : 'none');
    }
    const planVisible = baseLayerId === 'plan-ign';
    // mode satellite hybride: la photo garde les toponymes, routes et sentiers du plan vectoriel
    const hybrid = baseLayerId === 'ortho';
    for (const layer of vectorLayersRef.current) {
      const inBase = planVisible || (hybrid && (layer.type === 'symbol' || layer.type === 'line'));
      const show = layer.visible && inBase && (overlays.contours || !layer.isContour);
      map.setLayoutProperty(layer.id, 'visibility', show ? 'visible' : 'none');
    }
  }, [baseLayerId, overlays.contours, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.setLayoutProperty('overlay-hillshade', 'visibility', overlays.hillshade ? 'visible' : 'none');
    map.setLayoutProperty('overlay-slopes', 'visibility', overlays.slopes ? 'visible' : 'none');
    map.setLayoutProperty('overlay-gr', 'visibility', overlays.gr ? 'visible' : 'none');
    map.setLayoutProperty('overlay-hidden', 'visibility', overlays.hidden ? 'visible' : 'none');
    map.setLayoutProperty('overlay-refuges', 'visibility', overlays.refuges ? 'visible' : 'none');
    map.setTerrain(overlays.terrain3d ? { source: 'terrain-3d', exaggeration: terrainExagRef.current } : null);
  }, [overlays, mapReady]);

  // exagération adaptée au relief à l'écran, réévaluée quand la carte se stabilise
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !overlays.terrain3d) return;
    const update = () => {
      const next = adaptiveExaggeration(map, terrainExagRef.current);
      if (next === null || Math.abs(next - terrainExagRef.current) < TERRAIN_EXAGGERATION_STEP) return;
      terrainExagRef.current = next;
      map.setTerrain({ source: 'terrain-3d', exaggeration: next });
    };
    map.on('idle', update);
    return () => {
      map.off('idle', update);
    };
  }, [overlays.terrain3d, mapReady]);

  // les données des deux overlays à la volée suivent le viewport tant qu'ils sont actifs
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || (!overlays.hidden && !overlays.refuges)) return;
    const refresh = () => {
      void refreshPoiOverlays(map, overlays.hidden, overlays.refuges);
    };
    refresh();
    map.on('moveend', refresh);
    return () => {
      map.off('moveend', refresh);
    };
  }, [overlays.hidden, overlays.refuges, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const coords = routeCoords(legs);
    const data: GeoJSON.GeoJSON =
      coords.length >= 2
        ? {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: coords.map(([lon, lat]) => [lon, lat]) },
          }
        : EMPTY_ROUTE;
    (map.getSource(ROUTE_SOURCE) as GeoJSONSource).setData(data);

    kmMarkersRef.current.forEach(m => {
      m.remove();
    });
    kmMarkersRef.current = [];
    if (overlays.km && coords.length >= 2) {
      const dists = cumulativeDistancesM(coords);
      const stepM = dists[dists.length - 1] > 30_000 ? 5_000 : 1_000;
      kmMarkersRef.current = kmMarkerPoints(coords, dists, stepM).map(pt => {
        const el = document.createElement('div');
        el.className = 'km-marker';
        el.textContent = String(pt.km);
        return new Marker({ element: el }).setLngLat([pt.lon, pt.lat]).addTo(map);
      });
    }
  }, [legs, mapReady, overlays.km]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource(HIGHLIGHT_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    if (!wayTypeHighlight) {
      source.setData(EMPTY_ROUTE);
      return;
    }
    // spans contigus de la trace correspondant à la valeur survolée, fusionnés quand adjacents
    const lines: [number, number][][] = [];
    for (const slot of legs) {
      const leg = slot.leg;
      if (!leg?.waySegments) continue;
      let prevEnd = 0;
      let spanStart = -1;
      for (const seg of leg.waySegments) {
        const matches = seg[wayTypeHighlight.dim] === wayTypeHighlight.value && seg.endIndex > prevEnd;
        if (matches && spanStart < 0) spanStart = prevEnd;
        if (!matches && spanStart >= 0) {
          lines.push(leg.coords.slice(spanStart, prevEnd + 1).map(c => [c[0], c[1]]));
          spanStart = -1;
        }
        prevEnd = Math.max(prevEnd, seg.endIndex);
      }
      if (spanStart >= 0) lines.push(leg.coords.slice(spanStart, prevEnd + 1).map(c => [c[0], c[1]]));
    }
    const color =
      wayTypeHighlight.dim === 'category'
        ? WAY_COLORS[wayTypeHighlight.value as WayCategory]
        : SURFACE_COLORS[wayTypeHighlight.value as SurfaceCategory];
    map.setPaintProperty('waytype-highlight', 'line-color', color ?? '#2f9e44');
    source.setData(
      lines.length > 0
        ? { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: lines } }
        : EMPTY_ROUTE,
    );
  }, [wayTypeHighlight, legs, mapReady]);

  // biome-ignore lint/correctness/useExhaustiveDependencies(lang): les titres des marqueurs (tNow) doivent suivre la langue
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    anchorMarkersRef.current.forEach(m => {
      m.remove();
    });
    anchorMarkersRef.current = anchors.map((anchor, index) => {
      const el =
        anchor.kind === 'checkpoint'
          ? checkpointElement(index === 0, index === anchors.length - 1 && anchors.length > 1)
          : pointElement(anchor.kind, anchor.name);
      attachEditOnClick(el, anchor.id);
      const marker = new Marker({ element: el, draggable: true }).setLngLat([anchor.lon, anchor.lat]).addTo(map);
      // pendant le drag: ligne élastique à chaque frame + recalcul routé throttlé; au drop: routage définitif
      const setDragLine = (cursor: [number, number] | null) => {
        const source = map.getSource(DRAG_SOURCE) as GeoJSONSource | undefined;
        if (!source) return;
        if (!cursor) {
          source.setData(EMPTY_ROUTE);
          return;
        }
        const all = usePlanner.getState().anchors;
        const points = [all[index - 1], all[index + 1]]
          .filter(a => a !== undefined)
          .map(a => [a.lon, a.lat] as [number, number]);
        if (points.length === 0) return;
        source.setData({
          type: 'Feature',
          properties: {},
          geometry:
            points.length === 2
              ? {
                  type: 'MultiLineString',
                  coordinates: [
                    [points[0], cursor],
                    [cursor, points[1]],
                  ],
                }
              : { type: 'LineString', coordinates: [points[0], cursor] },
        });
      };
      let lastReroute = 0;
      marker.on('dragstart', () => usePlanner.getState().beginDragAnchor());
      marker.on('drag', () => {
        const { lng, lat } = marker.getLngLat();
        setDragLine([lng, lat]);
        const now = performance.now();
        if (now - lastReroute < DRAG_REROUTE_MS) return;
        lastReroute = now;
        usePlanner.getState().dragAnchor(index, [lng, lat]);
      });
      marker.on('dragend', () => {
        setDragLine(null);
        const { lng, lat } = marker.getLngLat();
        usePlanner.getState().moveAnchor(index, [lng, lat]);
      });
      return marker;
    });
  }, [anchors, mapReady, lang]);

  // biome-ignore lint/correctness/useExhaustiveDependencies(lang): les titres des marqueurs (tNow) doivent suivre la langue
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    offRouteMarkersRef.current.forEach(m => {
      m.remove();
    });
    offRouteMarkersRef.current = offRoutePoints.map(w => {
      const el = pointElement(w.kind, w.name);
      attachEditOnClick(el, w.id);
      const marker = new Marker({ element: el, anchor: 'left', draggable: true }).setLngLat([w.lon, w.lat]).addTo(map);
      marker.on('dragend', () => {
        const { lng, lat } = marker.getLngLat();
        usePlanner.getState().moveOffRoutePoint(w.id, [lng, lat]);
      });
      return marker;
    });
  }, [offRoutePoints, mapReady, lang]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!hoverMarkerRef.current) {
      const el = document.createElement('div');
      el.className = 'hover-marker';
      hoverMarkerRef.current = new Marker({ element: el });
    }
    if (hoverPoint) hoverMarkerRef.current.setLngLat(hoverPoint).addTo(map);
    else hoverMarkerRef.current.remove();
  }, [hoverPoint]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !flyTo) return;
    if ('center' in flyTo) map.flyTo({ center: flyTo.center, zoom: flyTo.zoom });
    else map.fitBounds(flyTo.bounds, { padding: 80, maxZoom: 15 });
    usePlanner.getState().setFlyTo(null);
  }, [flyTo]);

  return <div ref={containerRef} className="map" />;
}

// wrapper indispensable: maplibre positionne le marqueur via transform sur l'élément racine,
// le scale au survol doit donc vivre sur un enfant
// dernier rafraîchissement lancé gagne: un setData tardif d'un ancien viewport est ignoré
let poiRefreshToken = 0;

/**
 * Exagération souhaitable pour le relief actuellement à l'écran, ou null si le MNT n'est pas prêt.
 *
 * Échantillonne l'altitude sur une grille de points du viewport (tuiles de terrain déjà chargées,
 * aucune requête), puis vise un relief apparent d'environ TERRAIN_RELIEF_TARGET de la largeur
 * visible, borné entre TERRAIN_EXAGGERATION_MIN et MAX.
 *
 * Args:
 *   map: carte avec le terrain 3D actif.
 *   applied: exagération en place, car queryTerrainElevation renvoie des altitudes déjà exagérées.
 */
function adaptiveExaggeration(map: MapLibreMap, applied: number): number | null {
  const canvas = map.getCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const elevations: number[] = [];
  // grille sur les deux tiers inférieurs de l'écran: en vue inclinée, le haut est le ciel
  for (let col = 0; col <= 4; col++) {
    for (let row = 0; row <= 4; row++) {
      const point = map.unproject([(width * col) / 4, height * (0.35 + (0.65 * row) / 4)]);
      const elevation = map.queryTerrainElevation(point);
      if (elevation !== null) elevations.push(elevation / applied);
    }
  }
  if (elevations.length < 8) return null;
  const relief = Math.max(...elevations) - Math.min(...elevations);
  const bottomY = height * 0.9;
  const viewWidthM = map.unproject([0, bottomY]).distanceTo(map.unproject([width, bottomY]));
  const target = (viewWidthM * TERRAIN_RELIEF_TARGET) / Math.max(relief, 1);
  return Math.min(TERRAIN_EXAGGERATION_MAX, Math.max(TERRAIN_EXAGGERATION_MIN, target));
}

async function refreshPoiOverlays(map: MapLibreMap, hidden: boolean, refuges: boolean): Promise<void> {
  const token = ++poiRefreshToken;
  const zoom = map.getZoom();
  const b = map.getBounds();
  const bounds = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  if (hidden) {
    const features = zoom >= HIDDEN_TRAILS_MIN_ZOOM ? await fetchHiddenTrails(bounds) : [];
    if (token === poiRefreshToken) {
      (map.getSource(HIDDEN_TRAILS_SOURCE) as GeoJSONSource | undefined)?.setData({
        type: 'FeatureCollection',
        features,
      });
    }
  }
  if (refuges) {
    const features = zoom >= REFUGES_MIN_ZOOM ? await fetchRefugePoints(bounds) : [];
    if (token === poiRefreshToken) {
      (map.getSource(REFUGES_SOURCE) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
    }
  }
}

// pastille dessinée en 2x (pixelRatio 2): disque blanc, anneau couleur catégorie, pictogramme
function refugeBadgeImage(cat: RefugeCategory): ImageData {
  const size = 44;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new ImageData(size, size);
  const center = size / 2;
  ctx.beginPath();
  ctx.arc(center, center, center - 3, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = REFUGE_CATEGORY_COLORS[cat];
  ctx.stroke();
  ctx.font = '22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(REFUGE_CATEGORY_EMOJI[cat], center, center + 2);
  return ctx.getImageData(0, 0, size, size);
}

// contenu construit en DOM (pas de HTML injecté): les textes viennent d'une API externe
function refugePopupContent(props: Record<string, unknown>): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'refuge-pop';
  const title = document.createElement('strong');
  title.textContent = String(props.nom ?? '');
  const meta = document.createElement('div');
  meta.className = 'refuge-pop-meta';
  meta.textContent = `${props.type ?? ''}${props.alt ? ` · ${props.alt} m` : ''}`;
  el.append(title, meta);
  if (props.lien) {
    const link = document.createElement('a');
    link.href = String(props.lien);
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'refuges.info ↗';
    el.append(link);
  }
  return el;
}

function checkpointElement(isStart: boolean, isEnd: boolean): HTMLDivElement {
  const el = document.createElement('div');
  el.className = 'anchor-wrap';
  el.title = isStart ? tNow('start') : isEnd ? tNow('end') : tNow('title_point');
  const dot = document.createElement('span');
  dot.className = isStart ? 'anchor-marker anchor-start' : isEnd ? 'anchor-marker anchor-end' : 'anchor-marker';
  el.append(dot);
  return el;
}

function pointElement(kind: PointKind, name: string): HTMLDivElement {
  const def = kindDef(kind);
  const el = document.createElement('div');
  el.className = 'wp-marker';
  el.title = tNow('title_edit');
  const icon = document.createElement('span');
  icon.className = 'poi-icon';
  icon.textContent = def.emoji;
  icon.style.borderColor = def.color;
  el.append(icon);
  if (name) {
    const label = document.createElement('span');
    label.className = 'wp-label';
    label.textContent = name;
    el.append(label);
  }
  return el;
}

function attachEditOnClick(el: HTMLElement, anchorId: string) {
  el.addEventListener('click', e => {
    e.stopPropagation();
    usePlanner.getState().setEditing(anchorId);
  });
}

interface StyleBundle {
  style: StyleSpecification;
  vectorLayers: { id: string; type: string; isContour: boolean; visible: boolean }[];
}

// fond vectoriel Plan IGN (net en hidpi) + fonds raster cachés + overlays relief/pentes/GR
async function buildStyle(): Promise<StyleBundle> {
  const ignStyle: StyleSpecification | null = await fetch(PLAN_IGN_STYLE_URL)
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);

  const rasterBaseLayers: LayerSpecification[] = RASTER_BASE_LAYERS.map(l => ({
    id: l.id,
    type: 'raster',
    source: l.id,
    layout: { visibility: 'none' },
  }));
  const overlayLayers: LayerSpecification[] = [
    {
      id: 'overlay-hillshade',
      type: 'hillshade',
      source: 'terrain-dem',
      layout: { visibility: 'none' },
      paint: { 'hillshade-exaggeration': 0.4 },
    },
    {
      id: 'overlay-slopes',
      type: 'raster',
      source: 'slopes-src',
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': 0.55 },
    },
    { id: 'overlay-gr', type: 'raster', source: 'gr-src', layout: { visibility: 'none' } },
  ];

  const style: StyleSpecification = {
    version: 8,
    ...(ignStyle?.glyphs ? { glyphs: ignStyle.glyphs } : {}),
    ...(ignStyle?.sprite ? { sprite: ignStyle.sprite } : {}),
    sources: {
      ...(ignStyle?.sources ?? {}),
      ...Object.fromEntries(
        RASTER_BASE_LAYERS.map(l => [
          l.id,
          { type: 'raster', tiles: [l.tiles], tileSize: 256, maxzoom: l.maxzoom, attribution: l.attribution },
        ]),
      ),
      'terrain-dem': {
        type: 'raster-dem',
        encoding: 'terrarium',
        tiles: [TERRARIUM_TILES],
        tileSize: 256,
        maxzoom: 15,
      },
      // source dédiée au terrain 3D: maplibre déconseille de partager la source du hillshade avec setTerrain
      'terrain-3d': {
        type: 'raster-dem',
        encoding: 'terrarium',
        tiles: [TERRARIUM_TILES],
        tileSize: 256,
        maxzoom: 15,
      },
      'slopes-src': { type: 'raster', tiles: [SLOPES_TILES], tileSize: 256, maxzoom: 15 },
      'gr-src': { type: 'raster', tiles: [GR_TILES], tileSize: 256, maxzoom: 18, attribution: '© Waymarked Trails' },
    },
    layers: [...rasterBaseLayers, ...(ignStyle?.layers ?? []), ...overlayLayers],
  };

  const vectorLayers = (ignStyle?.layers ?? []).map(l => ({
    id: l.id,
    type: l.type,
    // les courbes de niveau et leurs cotes partagent le source-layer oro_courbe
    isContour: ('source-layer' in l ? l['source-layer'] : undefined) === CONTOUR_SOURCE_LAYER,
    visible: ('layout' in l ? (l.layout as { visibility?: string } | undefined)?.visibility : undefined) !== 'none',
  }));
  return { style, vectorLayers };
}
