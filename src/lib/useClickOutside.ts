import { type RefObject, useEffect, useRef } from 'react';

/**
 * Closes a floating widget as soon as the user interacts elsewhere.
 *
 * Capture phase, before the map handlers, and the callback lives in a ref: an inline callback in
 * the dependency array makes the listener churn on every render, which loses events dispatched
 * while React is flushing (see useEscapeKey for the case that caught it).
 *
 * Args:
 *   ref: the widget; a pointer down inside it is not "outside".
 *   onOutside: called when the interaction lands elsewhere.
 *   active: false unsubscribes.
 */
export function useClickOutside(ref: RefObject<HTMLElement | null>, onOutside: () => void, active: boolean): void {
  const latest = useRef(onOutside);
  latest.current = onOutside;

  useEffect(() => {
    if (!active) return;
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) latest.current();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [ref, active]);
}
