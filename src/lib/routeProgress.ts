/**
 * Where along the route we currently are, broadcast to whoever draws it.
 *
 * Two features publish that: the 3D flyover (a virtual position) and the follow mode (a real
 * GPS fix). The elevation profile mirrors it either way, so the channel is shared rather than
 * duplicated. Window events instead of store state on purpose: a position arrives many times a
 * second, and a zustand write per fix would re-render subscribers and re-arm the draft writer.
 */

const PROGRESS_EVENT = 'cairn:route-progress';
const SCRUB_EVENT = 'cairn:route-scrub';

/** Publishes the distance travelled along the route, in metres. */
export function emitProgress(distM: number): void {
  window.dispatchEvent(new CustomEvent<number>(PROGRESS_EVENT, { detail: distM }));
}

/**
 * Subscribes to the position along the route.
 *
 * Args:
 *   listener: receives the distance travelled, in metres.
 *
 * Returns:
 *   An unsubscribe function.
 */
export function onProgress(listener: (distM: number) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<number>).detail);
  window.addEventListener(PROGRESS_EVENT, handler);
  return () => window.removeEventListener(PROGRESS_EVENT, handler);
}

/** Asks the running playback to jump to a position, from a drag on the profile. */
export function requestScrub(distM: number): void {
  window.dispatchEvent(new CustomEvent<number>(SCRUB_EVENT, { detail: distM }));
}

export function onScrub(listener: (distM: number) => void): () => void {
  const handler = (e: Event) => listener((e as CustomEvent<number>).detail);
  window.addEventListener(SCRUB_EVENT, handler);
  return () => window.removeEventListener(SCRUB_EVENT, handler);
}
