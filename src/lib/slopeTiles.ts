import { addProtocol } from 'maplibre-gl';
import { demTileElevations, DEM_TILE_SIZE as SIZE } from './demElevation';

const EQUATOR_M_PER_PX = 156543.03392;

// classes designed for bivouacking: green is pitchable, a few degrees more are felt inside the tent
const SLOPE_CLASSES: { maxDeg: number; color: [number, number, number, number] }[] = [
  { maxDeg: 3, color: [46, 160, 67, 80] },
  { maxDeg: 6, color: [255, 213, 0, 80] },
  { maxDeg: 10, color: [235, 104, 52, 100] },
  { maxDeg: 25, color: [227, 73, 72, 110] },
  { maxDeg: 90, color: [124, 77, 190, 125] },
];

export const SLOPE_LEGEND = [
  { label: '0-3°', color: 'rgb(46, 160, 67)' },
  { label: '3-6°', color: 'rgb(255, 213, 0)' },
  { label: '6-10°', color: 'rgb(235, 104, 52)' },
  { label: '10-25°', color: 'rgb(227, 73, 72)' },
  { label: '> 25°', color: 'rgb(124, 77, 190)' },
];

export function slopeColorForDeg(deg: number): string {
  const cls = SLOPE_CLASSES.find(c => Math.abs(deg) <= c.maxDeg) ?? SLOPE_CLASSES[SLOPE_CLASSES.length - 1];
  return `rgb(${cls.color[0]}, ${cls.color[1]}, ${cls.color[2]})`;
}

let registered = false;

// slope tiles computed in the browser from the Terrarium DEM
export function registerSlopeProtocol(): void {
  if (registered) return;
  registered = true;
  addProtocol('slope', async ({ url }) => {
    const [z, x, y] = url.replace('slope://', '').split('/').map(Number);
    const elevations = await demTileElevations(z, x, y);
    const metersPerPixel = (EQUATOR_M_PER_PX * Math.cos(tileCenterLatRad(z, y))) / 2 ** z;

    const out = new ImageData(SIZE, SIZE);
    for (let py = 0; py < SIZE; py++) {
      for (let px = 0; px < SIZE; px++) {
        const deg = slopeDegAt(elevations, px, py, metersPerPixel);
        const cls = SLOPE_CLASSES.find(c => deg <= c.maxDeg) ?? SLOPE_CLASSES[SLOPE_CLASSES.length - 1];
        const i = (py * SIZE + px) * 4;
        out.data[i] = cls.color[0];
        out.data[i + 1] = cls.color[1];
        out.data[i + 2] = cls.color[2];
        out.data[i + 3] = cls.color[3];
      }
    }

    const canvas = new OffscreenCanvas(SIZE, SIZE);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas unavailable');
    ctx.putImageData(out, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { data: await blob.arrayBuffer() };
  });
}

/**
 * Slope in degrees at one pixel, from the elevation gradient.
 *
 * On a tile border one neighbor is missing, so the derivative is one-sided: dividing by the
 * actual pixel span, not always by two, otherwise the border reads as half its real slope
 * and a steep strip would look tent-friendly.
 *
 * Args:
 *   elevations: decoded tile, row major.
 *   px, py: pixel coordinates inside the tile.
 *   metersPerPixel: ground resolution at this latitude.
 */
function slopeDegAt(elevations: Float32Array, px: number, py: number, metersPerPixel: number): number {
  const x1 = Math.max(0, px - 1);
  const x2 = Math.min(SIZE - 1, px + 1);
  const y1 = Math.max(0, py - 1);
  const y2 = Math.min(SIZE - 1, py + 1);
  const dzdx = (at(elevations, x2, py) - at(elevations, x1, py)) / ((x2 - x1) * metersPerPixel);
  const dzdy = (at(elevations, px, y2) - at(elevations, px, y1)) / ((y2 - y1) * metersPerPixel);
  return (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
}

function at(elevations: Float32Array, x: number, y: number): number {
  return elevations[y * SIZE + x];
}

function tileCenterLatRad(z: number, y: number): number {
  const n = Math.PI - (2 * Math.PI * (y + 0.5)) / 2 ** z;
  return Math.atan(Math.sinh(n));
}
