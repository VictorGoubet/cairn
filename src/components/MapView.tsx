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
  FLYOVER_BASE_LAYER,
  GR_TILES,
  PLAN_IGN_STYLE_URL,
  RASTER_BASE_LAYERS,
  SLOPES_TILES,
  TERRARIUM_TILES,
} from '../config/layers';
import { FLYOVER_EXAGGERATION, type FlyoverPoi, startFlyover } from '../lib/flyover';
import { onFollowFix } from '../lib/follow';
import { cumulativeDistancesM, haversineM, kmMarkerPoints, type LonLatEle, nearestIndex } from '../lib/geo';
import { fetchHiddenTrails, HIDDEN_TRAILS_MIN_ZOOM } from '../lib/hiddenTrails';
import { tNow, useT } from '../lib/i18n';
import { bindLongPress, bindMiddleDragRotate, bindRotateCursor } from '../lib/mapGestures';
import { setMapInstance } from '../lib/mapHandle';
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

// standard reroute cadence while dragging (see Leaflet Routing Machine's routeDragInterval)
const DRAG_REROUTE_MS = 450;
const CONTOUR_SOURCE_LAYER = 'oro_courbe';
// off-route points farther than this from the trail do not pulse during the flyover
const OFF_ROUTE_PULSE_MAX_M = 400;
/** viewport-driven fetches wait for the camera to settle */
const POI_REFRESH_DEBOUNCE_MS = 800;

// 3D terrain exaggeration adapted to the visible relief: classic cartographic rule (Imhof),
// flatland needs 2-3x to read. The floor stays well above 1: zoomed into a massif the adaptive
// target collapses towards true scale, and true-scale mountains on a screen look small.
const TERRAIN_EXAGGERATION_MIN = 1.5;
const TERRAIN_EXAGGERATION_MAX = 3;
/** the visible relief should span roughly this fraction of the viewport width */
const TERRAIN_RELIEF_TARGET = 0.05;
/** below this delta, the exaggeration already in place is kept (avoids jerky jumps) */
const TERRAIN_EXAGGERATION_STEP = 0.25;

// once bundled, maplibre can no longer locate its worker (relative import to
// maplibre-gl-shared.mjs): let Vite bundle the worker and hand maplibre its URL
setWorkerUrl(maplibreWorkerUrl);

registerSlopeProtocol();

const ROUTE_SOURCE = 'route';
const DRAG_SOURCE = 'drag-line';
const HIGHLIGHT_SOURCE = 'waytype-highlight';
const SELECTION_SOURCE = 'profile-selection';
const HIDDEN_TRAILS_SOURCE = 'hidden-trails';
const REFUGES_SOURCE = 'refuge-points';
const FOLLOW_SOURCE = 'follow-position';
const EMPTY_ROUTE: GeoJSON.GeoJSON = { type: 'FeatureCollection', features: [] };

export function MapView() {
  const t = useT();
  const [zoomLevel, setZoomLevel] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const vectorLayersRef = useRef<{ id: string; type: string; isContour: boolean; visible: boolean }[]>([]);
  const anchorMarkersRef = useRef<Marker[]>([]);
  const offRouteMarkersRef = useRef<Marker[]>([]);
  const kmMarkersRef = useRef<Marker[]>([]);
  const hoverMarkerRef = useRef<Marker | null>(null);
  const searchPinRef = useRef<Marker | null>(null);
  const terrainExagRef = useRef(TERRAIN_EXAGGERATION_MIN);
  const [mapReady, setMapReady] = useState(false);

  const lang = usePlanner(s => s.lang);
  const baseLayerId = usePlanner(s => s.baseLayerId);
  const overlays = usePlanner(s => s.overlays);
  const anchors = usePlanner(s => s.anchors);
  const legs = usePlanner(s => s.legs);
  const offRoutePoints = usePlanner(s => s.offRoutePoints);
  const hoverPoint = usePlanner(s => s.hoverPoint);
  const searchPin = usePlanner(s => s.searchPin);
  const following = usePlanner(s => s.following);
  const flyTo = usePlanner(s => s.flyTo);
  const dragging = usePlanner(s => s.dragging);
  const wayTypeHighlight = usePlanner(s => s.wayTypeHighlight);
  const profileSelection = usePlanner(s => s.profileSelection);
  const flyover = usePlanner(s => s.flyover);

  useEffect(() => {
    let cancelled = false;
    let map: MapLibreMap | null = null;
    let disposeGestures: (() => void)[] = [];
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
        // highlights the segments matching the hovered legend entry (way types, surfaces)
        map.addSource(HIGHLIGHT_SOURCE, { type: 'geojson', data: EMPTY_ROUTE });
        map.addLayer({
          id: 'waytype-highlight',
          type: 'line',
          source: HIGHLIGHT_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#2f9e44', 'line-width': 7, 'line-opacity': 0.95 },
        });
        // live position while following: a halo for the accuracy, a dot for the fix
        map.addSource(FOLLOW_SOURCE, { type: 'geojson', data: EMPTY_ROUTE });
        map.addLayer({
          id: 'follow-accuracy',
          type: 'circle',
          source: FOLLOW_SOURCE,
          layout: { visibility: 'none' },
          paint: {
            'circle-color': '#2a78d6',
            'circle-opacity': 0.15,
            'circle-stroke-color': '#2a78d6',
            'circle-stroke-opacity': 0.4,
            'circle-stroke-width': 1,
            // the reported accuracy, in metres, drawn to scale
            'circle-radius': [
              'interpolate',
              ['exponential', 2],
              ['zoom'],
              10,
              ['/', ['get', 'accuracy'], 100],
              20,
              ['/', ['get', 'accuracy'], 0.1],
            ],
          },
        });
        map.addLayer({
          id: 'follow-dot',
          type: 'circle',
          source: FOLLOW_SOURCE,
          layout: { visibility: 'none' },
          paint: {
            'circle-radius': 7,
            'circle-color': '#2a78d6',
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 3,
          },
        });
        // the stretch selected on the elevation profile, drawn over the route
        map.addSource(SELECTION_SOURCE, { type: 'geojson', data: EMPTY_ROUTE });
        map.addLayer({
          id: 'profile-selection',
          type: 'line',
          source: SELECTION_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#2a78d6', 'line-width': 8, 'line-opacity': 0.55 },
        });
        // faint OSM trails + refuges.info points, loaded on the fly per cell (see tileGrid)
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
        // elastic line neighbor → cursor → neighbor, the only one following the mouse during a drag
        map.addSource(DRAG_SOURCE, { type: 'geojson', data: EMPTY_ROUTE });
        map.addLayer({
          id: 'drag-line',
          type: 'line',
          source: DRAG_SOURCE,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#e34948', 'line-width': 2.5, 'line-opacity': 0.85, 'line-dasharray': [1, 2] },
        });

        // default cursor = drop a point; over the track = insert
        map.getCanvas().style.cursor = 'crosshair';
        // clicking the track inserts a point into the right leg instead of appending one at the end
        // a leg too short to split cannot take an insertion: let the click append a point instead
        map.on('click', 'route-line', e => {
          // always consumed: a click on the trace means "insert here", and if the splice declines
          // the honest outcome is nothing, not a point appended to the far end of the route
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
          if (suppressNextTap) {
            suppressNextTap = false;
            return;
          }
          if (!e.defaultPrevented) usePlanner.getState().addAnchor([e.lngLat.lng, e.lngLat.lat]);
        });
        map.on('contextmenu', e => {
          usePlanner.getState().addOffRoutePoint([e.lngLat.lng, e.lngLat.lat]);
        });
        disposeGestures = [
          bindRotateCursor(map),
          bindMiddleDragRotate(map),
          bindLongPress(map, p => {
            usePlanner.getState().addOffRoutePoint(p);
            // the press is consumed: the finger lifting must not also append a route point
            suppressNextTap = true;
          }),
        ];
        setMapReady(true);
      });
      mapRef.current = map;
      setMapInstance(map);
      if (import.meta.env.DEV) {
        Object.assign(window, { __map: map, __planner: usePlanner });
      }
    });
    return () => {
      cancelled = true;
      for (const dispose of disposeGestures) dispose();
      disposeGestures = [];
      map?.remove();
      mapRef.current = null;
      setMapInstance(null);
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
    // hybrid satellite mode: the imagery keeps the toponyms, roads and trails of the vector plan
    const hybrid = baseLayerId === 'ortho';
    for (const layer of vectorLayersRef.current) {
      const inBase = planVisible || (hybrid && (layer.type === 'symbol' || layer.type === 'line'));
      // bare imagery for the flight: laying out labels over a tilted view is the most expensive
      // thing on screen, and the ones that survive the camera pop in and out
      const show = !flyover && layer.visible && inBase && (overlays.contours || !layer.isContour);
      map.setLayoutProperty(layer.id, 'visibility', show ? 'visible' : 'none');
    }
  }, [baseLayerId, overlays.contours, flyover, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource(SELECTION_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    const coords = routeCoords(legs);
    if (!profileSelection || coords.length < 2) {
      source.setData(EMPTY_ROUTE);
      return;
    }
    const dists = cumulativeDistancesM(coords);
    const from = nearestIndex(dists, Math.min(profileSelection.fromM, profileSelection.toM));
    const to = nearestIndex(dists, Math.max(profileSelection.fromM, profileSelection.toM));
    const slice = coords.slice(from, to + 1);
    source.setData(
      slice.length >= 2
        ? {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: slice.map(([lon, lat]) => [lon, lat]) },
          }
        : EMPTY_ROUTE,
    );
  }, [profileSelection, legs, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.setLayoutProperty('overlay-hillshade', 'visibility', overlays.hillshade ? 'visible' : 'none');
    map.setLayoutProperty('overlay-slopes', 'visibility', overlays.slopes ? 'visible' : 'none');
    map.setLayoutProperty('overlay-gr', 'visibility', overlays.gr ? 'visible' : 'none');
    map.setLayoutProperty('overlay-hidden', 'visibility', overlays.hidden ? 'visible' : 'none');
    map.setLayoutProperty('overlay-refuges', 'visibility', overlays.refuges ? 'visible' : 'none');
    map.setTerrain(
      overlays.terrain3d
        ? flyover
          ? { source: 'terrain-flyover', exaggeration: FLYOVER_EXAGGERATION }
          : { source: 'terrain-3d', exaggeration: terrainExagRef.current }
        : null,
    );
  }, [overlays, flyover, mapReady]);

  // exaggeration adapted to the relief on screen, re-evaluated once the map settles
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !overlays.terrain3d || flyover) return;
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
  }, [overlays.terrain3d, flyover, mapReady]);

  // both on-the-fly overlays keep their data in sync with the viewport while they are active
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || (!overlays.hidden && !overlays.refuges)) return;
    const refresh = () => {
      void refreshPoiOverlays(map, overlays.hidden, overlays.refuges);
    };
    refresh();
    // only once the camera settles: zooming fires a moveend per notch, and firing a burst of
    // Overpass cells at every notch is how a free API starts answering 406
    let timer = 0;
    const onMoveEnd = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, POI_REFRESH_DEBOUNCE_MS);
    };
    map.on('moveend', onMoveEnd);
    return () => {
      window.clearTimeout(timer);
      map.off('moveend', onMoveEnd);
    };
  }, [overlays.hidden, overlays.refuges, mapReady]);

  // the zoom level drives the "come closer" hint of the on-the-fly overlays
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const onZoom = () => setZoomLevel(map.getZoom());
    onZoom();
    map.on('zoomend', onZoom);
    return () => {
      map.off('zoomend', onZoom);
    };
  }, [mapReady]);

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
    // rebuilding every badge on each reroute tick of a drag janks a long route for nothing
    if (overlays.km && !dragging && !flyover && coords.length >= 2) {
      const dists = cumulativeDistancesM(coords);
      const stepM = dists[dists.length - 1] > 30_000 ? 5_000 : 1_000;
      kmMarkersRef.current = kmMarkerPoints(coords, dists, stepM).map(pt => {
        const el = document.createElement('div');
        el.className = 'km-marker';
        el.textContent = String(pt.km);
        return new Marker({ element: el }).setLngLat([pt.lon, pt.lat]).addTo(map);
      });
    }
  }, [legs, mapReady, overlays.km, dragging, flyover]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource(HIGHLIGHT_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    if (!wayTypeHighlight) {
      source.setData(EMPTY_ROUTE);
      return;
    }
    // contiguous spans of the track matching the hovered value, merged when adjacent
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

  // biome-ignore lint/correctness/useExhaustiveDependencies(lang): the marker titles (tNow) must follow the language
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    anchorMarkersRef.current.forEach(m => {
      m.remove();
    });
    anchorMarkersRef.current = [];
    // no pins during the flight: with terrain on, every marker asks the elevation of its
    // position on every frame, and that bill grows with the route
    if (flyover) return;
    anchorMarkersRef.current = anchors.map((anchor, index) => {
      const el =
        anchor.kind === 'checkpoint'
          ? checkpointElement(index === 0, index === anchors.length - 1 && anchors.length > 1)
          : pointElement(anchor.kind, anchor.name);
      attachEditOnClick(el, anchor.id);
      const marker = new Marker({ element: el, draggable: true }).setLngLat([anchor.lon, anchor.lat]).addTo(map);
      // during the drag: elastic line on every frame + throttled route recompute; on drop: final routing
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
  }, [anchors, mapReady, lang, flyover]);

  // biome-ignore lint/correctness/useExhaustiveDependencies(lang): the marker titles (tNow) must follow the language
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    offRouteMarkersRef.current.forEach(m => {
      m.remove();
    });
    offRouteMarkersRef.current = [];
    if (flyover) return;
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
  }, [offRoutePoints, mapReady, lang, flyover]);

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

  // the live fix, mirrored on the map from the same channel the bar listens to
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    for (const layer of ['follow-accuracy', 'follow-dot']) {
      map.setLayoutProperty(layer, 'visibility', following ? 'visible' : 'none');
    }
    if (!following) {
      (map.getSource(FOLLOW_SOURCE) as GeoJSONSource | undefined)?.setData(EMPTY_ROUTE);
      return;
    }
    const off = onFollowFix(fix => {
      (map.getSource(FOLLOW_SOURCE) as GeoJSONSource | undefined)?.setData({
        type: 'Feature',
        properties: { accuracy: Math.max(fix.accuracyM, 5) },
        geometry: { type: 'Point', coordinates: fix.position },
      });
    });
    return off;
  }, [following, mapReady]);

  // the searched spot, as a pin that adds itself to the route when tapped
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !searchPin) {
      searchPinRef.current?.remove();
      searchPinRef.current = null;
      return;
    }
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'search-pin';
    el.title = tNow('add_to_route');
    el.setAttribute('aria-label', tNow('add_to_route'));
    // the glyph is counter-rotated inside the teardrop: a tilted plus reads as a cross, which
    // would promise the opposite of what the button does
    const glyph = document.createElement('span');
    glyph.textContent = '+';
    el.appendChild(glyph);
    el.addEventListener('click', () => {
      usePlanner.getState().addAnchor(searchPin);
      usePlanner.getState().setSearchPin(null);
    });
    searchPinRef.current?.remove();
    searchPinRef.current = new Marker({ element: el, anchor: 'bottom' }).setLngLat(searchPin).addTo(map);
    return () => {
      searchPinRef.current?.remove();
      searchPinRef.current = null;
    };
  }, [searchPin]);

  // mapReady matters: a shared link sets flyTo before the style finishes loading, and the
  // request would otherwise be dropped for good
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !flyover) return;
    const coords = routeCoords(usePlanner.getState().legs);
    if (coords.length < 2) return;

    // the flight is a scene of its own, and every difference from the planner view is also what
    // buys the frame rate: imagery instead of the pale plan, relief on, and nothing else
    const previous = {
      camera: { center: map.getCenter(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() },
      overlays: usePlanner.getState().overlays,
      baseLayerId: usePlanner.getState().baseLayerId,
      pixelRatio: map.getPixelRatio(),
    };
    usePlanner.getState().setBaseLayerId(FLYOVER_BASE_LAYER);
    usePlanner.getState().setOverlay('terrain3d', true);
    // hillshading exists to make the plan readable in 3D; over imagery it only costs DEM tiles.
    // The rest recompute on every viewport change, which here means on every frame.
    for (const heavy of ['hillshade', 'slopes', 'gr', 'hidden', 'refuges'] as const) {
      usePlanner.getState().setOverlay(heavy, false);
    }
    // one device pixel instead of two means a quarter of the pixels to shade, which is where the
    // frame budget goes on a 4K screen; at this speed the softer image goes unnoticed
    map.setPixelRatio(1);

    const handle = startFlyover(map, coords, flyoverPois(coords), () => usePlanner.getState().stopFlyover());
    handle.setPaused(usePlanner.getState().flyoverPaused);
    const unsubscribePause = usePlanner.subscribe(state => handle.setPaused(state.flyoverPaused));
    return () => {
      unsubscribePause();
      handle.stop();
      map.setPixelRatio(previous.pixelRatio);
      usePlanner.getState().setBaseLayerId(previous.baseLayerId);
      // terrain first: switching it back on would otherwise force hillshading over the restored value
      usePlanner.getState().setOverlay('terrain3d', previous.overlays.terrain3d);
      for (const [name, value] of Object.entries(previous.overlays) as [keyof typeof previous.overlays, boolean][]) {
        if (name !== 'terrain3d') usePlanner.getState().setOverlay(name, value);
      }
      map.easeTo({ ...previous.camera, duration: 600 });
    };
  }, [flyover, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !flyTo) return;
    if ('center' in flyTo) map.flyTo({ center: flyTo.center, zoom: flyTo.zoom });
    else map.fitBounds(flyTo.bounds, { padding: 80, maxZoom: 15 });
    usePlanner.getState().setFlyTo(null);
  }, [flyTo, mapReady]);

  // an overlay waiting for zoom must say so: switched on over a wide view it shows nothing,
  // which reads as broken rather than as "come closer"
  const overlayFloor = Math.min(
    overlays.refuges ? REFUGES_MIN_ZOOM : Number.POSITIVE_INFINITY,
    overlays.hidden ? HIDDEN_TRAILS_MIN_ZOOM : Number.POSITIVE_INFINITY,
  );
  const needsZoom = Number.isFinite(overlayFloor) && zoomLevel < overlayFloor;

  return (
    <div ref={containerRef} className="map">
      {needsZoom && <span className="zoom-hint">{t('zoom_for_pois')}</span>}
    </div>
  );
}

// the wrapper is required: maplibre positions the marker via a transform on the root element,
// so the hover scale has to live on a child
// last refresh started wins: a late setData from a stale viewport is ignored
let poiRefreshToken = 0;
// set by a long press, cleared by the click it generates
let suppressNextTap = false;

/**
 * Desirable exaggeration for the relief currently on screen, or null if the DEM is not ready.
 *
 * Samples elevation over a grid of viewport points (terrain tiles already loaded, no request),
 * then targets an apparent relief of about TERRAIN_RELIEF_TARGET of the visible width, clamped
 * between TERRAIN_EXAGGERATION_MIN and MAX.
 *
 * Args:
 *   map: map with 3D terrain active.
 *   applied: exaggeration in place, since queryTerrainElevation returns already exaggerated elevations.
 */
/**
 * Shows the rotation cursor while the right button is held, and restores the previous one.
 *
 * Args:
 *   map: map whose canvas carries the cursor.
 *
 * Returns:
 *   A disposer for the window listener, since the button can be released outside the canvas.
 */
// annotated points projected onto the route, for the crossing pulses of the flyover: route
// points carry their cumulative distance, off-route points snap to the nearest route vertex
function flyoverPois(coords: LonLatEle[]): FlyoverPoi[] {
  const { anchors, legs, offRoutePoints } = usePlanner.getState();
  const dists = cumulativeDistancesM(coords);
  const pois: FlyoverPoi[] = [];
  let cum = 0;
  anchors.forEach((anchor, i) => {
    if (i > 0) cum += legs[i - 1]?.leg?.distanceM ?? 0;
    if (anchor.kind !== 'checkpoint' || anchor.name) {
      pois.push({ lon: anchor.lon, lat: anchor.lat, distM: cum, label: poiLabel(anchor.kind, anchor.name) });
    }
  });
  for (const point of offRoutePoints) {
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    coords.forEach((c, i) => {
      const d = haversineM([point.lon, point.lat], [c[0], c[1]]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (bestD <= OFF_ROUTE_PULSE_MAX_M) {
      pois.push({ lon: point.lon, lat: point.lat, distM: dists[best], label: poiLabel(point.kind, point.name) });
    }
  }
  return pois.sort((a, b) => a.distM - b.distM);
}

function poiLabel(kind: PointKind, name: string): string {
  return `${kindDef(kind).emoji} ${name}`.trim();
}

function adaptiveExaggeration(map: MapLibreMap, applied: number): number | null {
  const canvas = map.getCanvas();
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const elevations: number[] = [];
  // grid over the lower two thirds of the screen: in a tilted view, the top is sky
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

// badge drawn at 2x (pixelRatio 2): white disc, category-colored ring, pictogram
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

// content built in the DOM (no injected HTML): the texts come from an external API
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

// Plan IGN vector base (crisp on hidpi) + hidden raster bases + relief/slopes/GR overlays
async function buildStyle(): Promise<StyleBundle> {
  const ignStyle: StyleSpecification | null = await fetch(PLAN_IGN_STYLE_URL)
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);

  const rasterBaseLayers: LayerSpecification[] = RASTER_BASE_LAYERS.map(l => ({
    id: l.id,
    type: 'raster',
    source: l.id,
    layout: { visibility: 'none' },
    // no cross-fade: on a moving camera it reads as the imagery blinking
    paint: { 'raster-fade-duration': 0 },
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
    // without a sky, everything above the horizon is unpainted: tilting the camera or
    // playing the flyover shows the page background through the top half of the screen
    sky: {
      'sky-color': '#4d9fe8',
      // a low blend keeps the blue dominant: high values wash the whole sky into the horizon
      'sky-horizon-blend': 0.2,
      'horizon-color': '#a8d3f2',
      'horizon-fog-blend': 0.5,
      'fog-color': '#dbe7f2',
      'fog-ground-blend': 0.02,
      'atmosphere-blend': 0.4,
    },
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
      // source dedicated to the 3D terrain: maplibre advises against sharing the hillshade source with setTerrain
      'terrain-3d': {
        type: 'raster-dem',
        encoding: 'terrarium',
        tiles: [TERRARIUM_TILES],
        tileSize: 256,
        maxzoom: 15,
      },
      // same relief for the flyover, capped two zooms coarser: a moving camera needs the
      // elevation of a whole valley at once, and one tile here stands in for sixteen at z15
      'terrain-flyover': {
        type: 'raster-dem',
        encoding: 'terrarium',
        tiles: [TERRARIUM_TILES],
        tileSize: 256,
        maxzoom: 13,
      },
      'slopes-src': { type: 'raster', tiles: [SLOPES_TILES], tileSize: 256, maxzoom: 15 },
      'gr-src': { type: 'raster', tiles: [GR_TILES], tileSize: 256, maxzoom: 18, attribution: '© Waymarked Trails' },
    },
    layers: [
      // a painted floor under everything: a missing tile shows this instead of the page
      { id: 'canvas-background', type: 'background', paint: { 'background-color': '#eae7e0' } },
      ...rasterBaseLayers,
      ...(ignStyle?.layers ?? []),
      ...overlayLayers,
    ],
  };

  const vectorLayers = (ignStyle?.layers ?? []).map(l => ({
    id: l.id,
    type: l.type,
    // contour lines (source-layer oro_courbe) and the elevation labels annotating them
    // ("toponyme - courbe ..." layers, served by another source-layer)
    isContour: ('source-layer' in l ? l['source-layer'] : undefined) === CONTOUR_SOURCE_LAYER || /courbe/i.test(l.id),
    visible: ('layout' in l ? (l.layout as { visibility?: string } | undefined)?.visibility : undefined) !== 'none',
  }));
  return { style, vectorLayers };
}
