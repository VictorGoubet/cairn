/**
 * Pointer gestures MapLibre does not provide: a rotation cursor, rotating with the middle
 * button, and a long press standing in for the right click on a touch screen.
 */

import type { Map as MapLibreMap } from 'maplibre-gl';
import { ROTATE_CURSOR } from './cursors';
import type { LonLat } from './geo';

const ROTATE_BUTTONS = new Set([1, 2]);
/** same sensitivity as MapLibre's own right-button drag, so both gestures feel alike */
const BEARING_DEG_PER_PX = 0.8;
const PITCH_DEG_PER_PX = 0.5;

const LONG_PRESS_MS = 500;
/** a finger never lands twice on the same pixel: allow a small wobble during the press */
const LONG_PRESS_SLOP_PX = 12;

/**
 * Shows the rotation cursor while a rotating button is held, and restores the previous one.
 *
 * Args:
 *   map: map whose canvas carries the cursor.
 *
 * Returns:
 *   A disposer, since the button can be released outside the canvas.
 */
export function bindRotateCursor(map: MapLibreMap): () => void {
  const canvas = map.getCanvas();
  let previousCursor: string | null = null;

  const onMouseDown = (e: MouseEvent) => {
    if (!ROTATE_BUTTONS.has(e.button) || previousCursor !== null) return;
    previousCursor = canvas.style.cursor;
    canvas.style.cursor = ROTATE_CURSOR;
  };
  const onMouseUp = () => {
    if (previousCursor === null) return;
    canvas.style.cursor = previousCursor;
    previousCursor = null;
  };

  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  return () => {
    canvas.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mouseup', onMouseUp);
  };
}

/**
 * Rotates and tilts the camera while the middle button is held.
 *
 * MapLibre only wires the right button, but a wheel press is the orbit gesture of most 3D
 * tools, and it is the one users reach for.
 *
 * Args:
 *   map: map to rotate.
 *
 * Returns:
 *   A disposer for the listeners.
 */
export function bindMiddleDragRotate(map: MapLibreMap): () => void {
  const canvas = map.getCanvas();
  let last: { x: number; y: number } | null = null;

  const onMouseDown = (e: MouseEvent) => {
    if (e.button !== 1) return;
    // without this the browser starts its autoscroll on a middle press
    e.preventDefault();
    last = { x: e.clientX, y: e.clientY };
  };
  const onMouseMove = (e: MouseEvent) => {
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
    map.setBearing(map.getBearing() - dx * BEARING_DEG_PER_PX);
    map.setPitch(Math.min(map.getMaxPitch(), Math.max(0, map.getPitch() - dy * PITCH_DEG_PER_PX)));
  };
  const onMouseUp = () => {
    last = null;
  };

  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  return () => {
    canvas.removeEventListener('mousedown', onMouseDown);
    window.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('mouseup', onMouseUp);
  };
}

/**
 * Calls back after a long press, the touch equivalent of the right click.
 *
 * Args:
 *   map: map whose canvas receives the touch events.
 *   onLongPress: receives the pressed position.
 *
 * Returns:
 *   A disposer for the listeners.
 */
export function bindLongPress(map: MapLibreMap, onLongPress: (p: LonLat) => void): () => void {
  const canvas = map.getCanvas();
  let timer = 0;
  let start: { x: number; y: number } | null = null;

  const cancel = () => {
    window.clearTimeout(timer);
    timer = 0;
    start = null;
  };

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 1) return cancel();
    const touch = e.touches[0];
    start = { x: touch.clientX, y: touch.clientY };
    timer = window.setTimeout(() => {
      if (!start) return;
      const rect = canvas.getBoundingClientRect();
      const lngLat = map.unproject([start.x - rect.left, start.y - rect.top]);
      onLongPress([lngLat.lng, lngLat.lat]);
      cancel();
    }, LONG_PRESS_MS);
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!start || e.touches.length !== 1) return cancel();
    const touch = e.touches[0];
    if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > LONG_PRESS_SLOP_PX) cancel();
  };

  canvas.addEventListener('touchstart', onTouchStart, { passive: true });
  canvas.addEventListener('touchmove', onTouchMove, { passive: true });
  canvas.addEventListener('touchend', cancel);
  canvas.addEventListener('touchcancel', cancel);
  return () => {
    cancel();
    canvas.removeEventListener('touchstart', onTouchStart);
    canvas.removeEventListener('touchmove', onTouchMove);
    canvas.removeEventListener('touchend', cancel);
    canvas.removeEventListener('touchcancel', cancel);
  };
}
