/**
 * Renders the route as a shareable image, the way Strava composes its social tiles.
 *
 * Everything is drawn on a plain canvas: the basemap (when wanted) comes from raster WMTS
 * tiles fetched with CORS so the canvas stays exportable, the trace and profile are drawn from
 * the route geometry, and the caller turns the canvas into a blob to copy, share or download.
 */

import { LngLatBounds, Map as MapLibreMap } from 'maplibre-gl';
import { ORTHO_RASTER_TILES, PLAN_IGN_RASTER_TILES, TERRARIUM_TILES } from '../config/layers';
import { elevationStats, formatDistance, formatDuration, hikingDurationH, type LonLatEle, pathDistanceM } from './geo';
import { tNow } from './i18n';

export type ShareFormat = 'square' | 'story';
export type ShareBackground = 'plan' | 'satellite' | 'relief' | 'transparent' | 'light';

export interface ShareImageOptions {
  format: ShareFormat;
  background: ShareBackground;
  showStats: boolean;
  showProfile: boolean;
  title: string;
  /** shrinks the whole composition, for thumbnail previews; 1 is the shareable size */
  scale?: number;
}

export const SHARE_SIZES: Record<ShareFormat, { w: number; h: number }> = {
  square: { w: 1080, h: 1080 },
  story: { w: 1080, h: 1920 },
};

/** widest zoom the WMTS layers serve everywhere, and a hard cap on fetched tiles */
const MAX_TILE_ZOOM = 16;
const MAX_TILES = 80;
/** the 3D scene starts anyway once this passes, offline relief beats no tile at all */
const RELIEF_IDLE_TIMEOUT_MS = 12_000;
const RELIEF_PITCH = 62;
/** share of the canvas the route leaves free around itself */
const VIEW_PADDING = 0.16;

const TRACE_COLOR = '#e34948';

interface View {
  zoom: number;
  scale: number;
  originX: number;
  originY: number;
}

/**
 * Draws the share tile onto the given canvas.
 *
 * Args:
 *   canvas: target canvas, resized to the chosen format.
 *   coords: route geometry with elevations, at least two points.
 *   options: format, background and content toggles.
 */
export async function renderShareImage(
  canvas: HTMLCanvasElement,
  coords: LonLatEle[],
  options: ShareImageOptions,
): Promise<void> {
  const scale = options.scale ?? 1;
  const w = Math.round(SHARE_SIZES[options.format].w * scale);
  const h = Math.round(SHARE_SIZES[options.format].h * scale);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, w, h);
  const relief = options.background === 'relief';
  const onMap = options.background === 'plan' || options.background === 'satellite' || relief;
  // white ink over imagery or over whatever photo the transparent tile lands on
  const lightInk = onMap || options.background === 'transparent';
  // on a basemap the route frames the whole canvas; on a plain background it sits in the
  // upper part, leaving the lower band to the stats, or dead center when nothing else shows
  const bare = !options.showStats && !options.showProfile;
  const traceBox = onMap
    ? { x: 0, y: 0, w, h }
    : bare
      ? { x: w * 0.12, y: h * 0.2, w: w * 0.76, h: h * 0.6 }
      : { x: w * 0.12, y: h * 0.14, w: w * 0.76, h: h * (options.format === 'story' ? 0.5 : 0.42) };
  const view = fitView(coords, traceBox.w, traceBox.h);

  if (options.background === 'light') drawBackground(ctx, w, h);
  if (relief) await drawReliefScene(ctx, coords, w, h);
  else if (onMap) await drawTiles(ctx, view, w, h, options.background === 'plan');
  drawScrims(ctx, w, h, onMap);
  // a soft shadow keeps white ink readable on whatever story photo sits behind the tile
  if (options.background === 'transparent') {
    ctx.shadowColor = 'rgba(10, 12, 16, 0.55)';
    ctx.shadowBlur = Math.round(w * 0.012);
  }
  // the relief scene drapes the trace on the terrain itself, a flat overlay would not line up
  if (!relief) drawTrace(ctx, coords, view, traceBox, onMap);
  if (options.showProfile) drawProfile(ctx, coords, w, h, options, lightInk);
  if (options.showStats) drawStats(ctx, coords, w, h, options, lightInk);
  await drawBrand(ctx, w, lightInk);
}

/** Web Mercator projection into the world square [0, 1). */
export function mercator(lon: number, lat: number): [number, number] {
  const clampedLat = Math.max(-85.051, Math.min(85.051, lat));
  const rad = (clampedLat * Math.PI) / 180;
  return [(lon + 180) / 360, (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2];
}

/**
 * Chooses the tile zoom and world-to-canvas transform framing the route.
 *
 * Args:
 *   coords: route geometry.
 *   boxW: width in pixels of the framing box.
 *   boxH: height in pixels of the framing box.
 *
 * Returns:
 *   A view whose `scale` maps world units to pixels, centered on the route.
 */
export function fitView(coords: LonLatEle[], boxW: number, boxH: number): View {
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  for (const [lon, lat] of coords) {
    const [x, y] = mercator(lon, lat);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const spanX = Math.max(maxX - minX, 1e-7);
  const spanY = Math.max(maxY - minY, 1e-7);
  const usableW = boxW * (1 - 2 * VIEW_PADDING);
  const usableH = boxH * (1 - 2 * VIEW_PADDING);
  const scale = Math.min(usableW / spanX, usableH / spanY);
  // ceil: tiles drawn slightly downscaled stay crisp, the count cap trims the excess
  const zoom = Math.min(MAX_TILE_ZOOM, Math.max(1, Math.ceil(Math.log2(scale / 256))));
  return {
    zoom,
    scale,
    originX: (minX + maxX) / 2 - boxW / 2 / scale,
    originY: (minY + maxY) / 2 - boxH / 2 / scale,
  };
}

/** world position to canvas pixels within the view */
function toPx(view: View, lon: number, lat: number): [number, number] {
  const [x, y] = mercator(lon, lat);
  return [(x - view.originX) * view.scale, (y - view.originY) * view.scale];
}

async function drawTiles(
  ctx: CanvasRenderingContext2D,
  view: View,
  w: number,
  h: number,
  plan: boolean,
): Promise<void> {
  let zoom = view.zoom;
  let tiles = 2 ** zoom;
  const range = () => {
    const x0 = Math.floor(view.originX * tiles);
    const y0 = Math.floor(view.originY * tiles);
    const x1 = Math.floor((view.originX + w / view.scale) * tiles);
    const y1 = Math.floor((view.originY + h / view.scale) * tiles);
    return { x0, y0, x1, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
  };
  while (zoom > 1 && range().count > MAX_TILES) {
    zoom--;
    tiles = 2 ** zoom;
  }
  const { x0, y0, x1, y1 } = range();
  const template = plan ? PLAN_IGN_RASTER_TILES : ORTHO_RASTER_TILES;
  const tilePx = view.scale / tiles;
  const jobs: Promise<void>[] = [];
  for (let ty = Math.max(y0, 0); ty <= Math.min(y1, tiles - 1); ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const url = template
        .replace('{z}', String(zoom))
        .replace('{x}', String(((tx % tiles) + tiles) % tiles))
        .replace('{y}', String(ty));
      jobs.push(
        loadImage(url).then(img => {
          ctx.drawImage(
            img,
            (tx / tiles - view.originX) * view.scale,
            (ty / tiles - view.originY) * view.scale,
            tilePx + 0.5,
            tilePx + 0.5,
          );
        }),
      );
    }
  }
  // a missing tile keeps the background color, the image is still worth sharing
  await Promise.allSettled(jobs);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`tile ${url}`));
    img.src = url;
  });
}

/**
 * Renders the route in 3D, draped on the relief, through a throwaway MapLibre instance.
 *
 * The map lives in an off-screen container with `preserveDrawingBuffer` so its canvas can be
 * composited once every tile has arrived (or the timeout passes). The camera looks down the
 * route's main axis, tilted like the flyover.
 */
async function drawReliefScene(
  ctx: CanvasRenderingContext2D,
  coords: LonLatEle[],
  w: number,
  h: number,
): Promise<void> {
  const container = document.createElement('div');
  container.style.cssText = `position:fixed;left:-100000px;top:0;width:${w}px;height:${h}px;`;
  document.body.appendChild(container);
  const map = new MapLibreMap({
    container,
    interactive: false,
    attributionControl: false,
    pixelRatio: 1,
    style: {
      version: 8,
      sources: {
        ortho: { type: 'raster', tiles: [ORTHO_RASTER_TILES], tileSize: 256, maxzoom: 19 },
        dem: { type: 'raster-dem', encoding: 'terrarium', tiles: [TERRARIUM_TILES], tileSize: 256, maxzoom: 13 },
      },
      sky: { 'sky-color': '#4d9fe8', 'sky-horizon-blend': 0.2, 'horizon-color': '#a8d3f2', 'fog-color': '#dbe7f2' },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#dbe7f2' } },
        { id: 'ortho', type: 'raster', source: 'ortho', paint: { 'raster-fade-duration': 0 } },
      ],
    },
  });
  try {
    await new Promise<void>(resolve => map.once('load', () => resolve()));
    map.setMaxPitch(RELIEF_PITCH);
    map.addSource('trace', {
      type: 'geojson',
      data: {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: coords.map(c => [c[0], c[1]]) },
      },
    });
    map.addLayer({
      id: 'trace-casing',
      type: 'line',
      source: 'trace',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 11 },
    });
    map.addLayer({
      id: 'trace-line',
      type: 'line',
      source: 'trace',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': TRACE_COLOR, 'line-width': 6.5 },
    });
    map.setTerrain({ source: 'dem', exaggeration: 1.3 });

    const bounds = coords.reduce(
      (acc, c) => acc.extend([c[0], c[1]]),
      new LngLatBounds([coords[0][0], coords[0][1]], [coords[0][0], coords[0][1]]),
    );
    // looking down the route's main axis, generous headroom for what the tilt pushes up
    const start = coords[0];
    const end = coords[coords.length - 1];
    const bearing = (Math.atan2(end[0] - start[0], end[1] - start[1]) * 180) / Math.PI;
    const frame = () => {
      map.fitBounds(bounds, {
        bearing,
        animate: false,
        padding: {
          top: Math.round(h * 0.24),
          bottom: Math.round(h * 0.15),
          left: Math.round(w * 0.1),
          right: Math.round(w * 0.1),
        },
      });
      map.setPitch(RELIEF_PITCH);
    };
    const settle = () =>
      new Promise<void>(resolve => {
        const timeout = window.setTimeout(resolve, RELIEF_IDLE_TIMEOUT_MS);
        map.once('idle', () => {
          window.clearTimeout(timeout);
          resolve();
        });
      });
    // twice on purpose: the first framing is computed for a ground at sea level, and once the
    // DEM arrives the camera can sit under the mountains, where the near plane clips the world
    frame();
    await settle();
    frame();
    await settle();
    // synchronous re-render then copy within the same task: one task later the WebGL buffer is
    // already presented and cleared, and the composite reads fully transparent
    // no preserveDrawingBuffer: the copy happens inside the render event, while the freshly
    // painted frame is still the current buffer (the documented screenshot pattern)
    await new Promise<void>(resolve => {
      map.once('render', () => {
        ctx.drawImage(map.getCanvas(), 0, 0, w, h);
        resolve();
      });
      map.triggerRepaint();
    });
  } finally {
    map.remove();
    container.remove();
  }
}

function drawBackground(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, '#fbfaf7');
  gradient.addColorStop(1, '#efece5');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
}

/** soft dark bands over a basemap so the brand and the stats stay readable on any imagery */
function drawScrims(ctx: CanvasRenderingContext2D, w: number, h: number, onMap: boolean): void {
  if (!onMap) return;
  const top = ctx.createLinearGradient(0, 0, 0, h * 0.14);
  top.addColorStop(0, 'rgba(10, 12, 16, 0.55)');
  top.addColorStop(1, 'rgba(10, 12, 16, 0)');
  ctx.fillStyle = top;
  ctx.fillRect(0, 0, w, h * 0.14);
  const bottom = ctx.createLinearGradient(0, h * 0.6, 0, h);
  bottom.addColorStop(0, 'rgba(10, 12, 16, 0)');
  bottom.addColorStop(1, 'rgba(10, 12, 16, 0.72)');
  ctx.fillStyle = bottom;
  ctx.fillRect(0, h * 0.6, w, h * 0.4);
}

function drawTrace(
  ctx: CanvasRenderingContext2D,
  coords: LonLatEle[],
  view: View,
  box: { x: number; y: number },
  onMap: boolean,
): void {
  ctx.save();
  ctx.translate(box.x, box.y);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const path = new Path2D();
  coords.forEach(([lon, lat], i) => {
    const [x, y] = toPx(view, lon, lat);
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  });
  // white casing over a map, soft glow on plain backgrounds
  if (onMap) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 13;
    ctx.stroke(path);
  } else {
    ctx.shadowColor = 'rgba(227, 73, 72, 0.45)';
    ctx.shadowBlur = 22;
  }
  ctx.strokeStyle = TRACE_COLOR;
  ctx.lineWidth = 7;
  ctx.stroke(path);
  ctx.shadowBlur = 0;

  const dot = (point: LonLatEle, fill: string) => {
    const [x, y] = toPx(view, point[0], point[1]);
    ctx.beginPath();
    ctx.arc(x, y, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  };
  dot(coords[0], '#2b9348');
  dot(coords[coords.length - 1], '#212529');
  ctx.restore();
}

function drawProfile(
  ctx: CanvasRenderingContext2D,
  coords: LonLatEle[],
  w: number,
  h: number,
  options: ShareImageOptions,
  lightInk: boolean,
): void {
  const box = { x: w * 0.08, w: w * 0.84, h: h * 0.07, y: h * (options.showStats ? 0.72 : 0.84) };
  const elevations = coords.map(c => c[2]);
  const min = Math.min(...elevations);
  const span = Math.max(Math.max(...elevations) - min, 30);
  ctx.save();
  ctx.beginPath();
  coords.forEach((c, i) => {
    const x = box.x + (i / (coords.length - 1)) * box.w;
    const y = box.y + box.h - ((c[2] - min) / span) * box.h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  const ink = lightInk ? '#ffffff' : '#2b2e34';
  ctx.strokeStyle = ink;
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.globalAlpha = 0.95;
  ctx.stroke();
  ctx.lineTo(box.x + box.w, box.y + box.h);
  ctx.lineTo(box.x, box.y + box.h);
  ctx.closePath();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = ink;
  ctx.fill();
  ctx.restore();
}

function drawStats(
  ctx: CanvasRenderingContext2D,
  coords: LonLatEle[],
  w: number,
  h: number,
  options: ShareImageOptions,
  lightInk: boolean,
): void {
  const { gainM, lossM } = elevationStats(coords);
  const distanceM = pathDistanceM(coords);
  const entries: [string, string][] = [
    [tNow('distance'), formatDistance(distanceM)],
    [tNow('dplus'), `${Math.round(gainM)} m`],
    [tNow('dminus'), `${Math.round(lossM)} m`],
    [tNow('duration_est'), formatDuration(hikingDurationH(distanceM, gainM, lossM))],
  ];
  const ink = lightInk ? '#ffffff' : '#212529';
  const sub = lightInk ? 'rgba(255,255,255,0.8)' : 'rgba(33,37,41,0.65)';
  const baseline = h * 0.9;

  ctx.save();
  ctx.fillStyle = ink;
  ctx.textAlign = 'left';
  if (options.title) {
    ctx.font = `700 ${Math.round(w * 0.048)}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
    ctx.fillText(truncate(ctx, options.title, w * 0.84), w * 0.08, baseline - w * 0.075);
  }
  const step = (w * 0.84) / entries.length;
  entries.forEach(([label, value], i) => {
    const x = w * 0.08 + i * step;
    ctx.fillStyle = sub;
    ctx.font = `600 ${Math.round(w * 0.024)}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
    ctx.fillText(label.toUpperCase(), x, baseline);
    ctx.fillStyle = ink;
    ctx.font = `700 ${Math.round(w * 0.04)}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
    ctx.fillText(value, x, baseline + w * 0.045);
  });
  ctx.restore();
}

async function drawBrand(ctx: CanvasRenderingContext2D, w: number, lightInk: boolean): Promise<void> {
  ctx.save();
  const size = Math.round(w * 0.125);
  const x = w * 0.05;
  const y = w * 0.035;
  let textX = x;
  // the wordmark survives a missing logo, the tile is still branded
  await loadImage(`${import.meta.env.BASE_URL}logo.png`).then(
    logo => {
      ctx.drawImage(logo, x, y, size, size);
      textX = x + size * 1.1;
    },
    () => undefined,
  );
  ctx.textAlign = 'left';
  ctx.fillStyle = lightInk ? '#ffffff' : '#212529';
  ctx.font = `800 ${Math.round(w * 0.075)}px -apple-system, 'Segoe UI', Roboto, sans-serif`;
  ctx.fillText('cairn', textX, y + size * 0.76);
  ctx.restore();
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxW) out = out.slice(0, -1);
  return `${out}…`;
}
