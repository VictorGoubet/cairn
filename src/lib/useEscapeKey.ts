import { useEffect, useRef } from 'react';

/**
 * Closes a floating widget on Escape, the counterpart of clicking outside it.
 *
 * The callback lives in a ref so the listener identity never changes. With an inline callback in
 * the dependency array, two stacked widgets fought: closing the first re-rendered the second,
 * whose effect unsubscribed and resubscribed while the keydown was still being dispatched, so
 * the second widget never saw the key (the mobile actions menu over the share studio, exactly).
 *
 * Args:
 *   onEscape: called once per keypress while active.
 *   active: false unsubscribes, so a closed widget ignores the key.
 */
export function useEscapeKey(onEscape: () => void, active: boolean): void {
  const latest = useRef(onEscape);
  latest.current = onEscape;

  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      latest.current();
    }
    // capture: a widget answers before the map shortcuts see the key
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [active]);
}
