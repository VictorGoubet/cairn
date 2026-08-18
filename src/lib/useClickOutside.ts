import { type RefObject, useEffect, useRef } from 'react';

/**
 * Closes a floating widget as soon as the user interacts elsewhere.
 *
 * Capture phase, before the map handlers, and the callback and refs live in refs: an inline
 * value in the dependency array makes the listener churn on every render, which loses events
 * dispatched while React is flushing (see useEscapeKey for the case that caught it).
 *
 * Args:
 *   ref: the widget, or several elements to treat as one (a menu and the button that toggles
 *     it: closing on the toggle's own tap would fight the toggle and reopen instead of closing).
 *   onOutside: called when the interaction lands elsewhere.
 *   active: false unsubscribes.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[],
  onOutside: () => void,
  active: boolean,
): void {
  const latest = useRef({ onOutside, refs: Array.isArray(ref) ? ref : [ref] });
  latest.current = { onOutside, refs: Array.isArray(ref) ? ref : [ref] };

  useEffect(() => {
    if (!active) return;
    function onPointerDown(e: PointerEvent) {
      const { refs, onOutside } = latest.current;
      const anchored = refs.filter(r => r.current !== null);
      if (anchored.length > 0 && anchored.every(r => !r.current?.contains(e.target as Node))) onOutside();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [active]);
}
