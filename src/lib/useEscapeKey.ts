import { useEffect } from 'react';

/**
 * Closes a floating widget on Escape, the counterpart of clicking outside it.
 *
 * Args:
 *   onEscape: called once per keypress while active.
 *   active: false unsubscribes, so several widgets never fight over the same key.
 */
export function useEscapeKey(onEscape: () => void, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onEscape();
    }
    // capture: a widget answers before the map shortcuts see the key
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onEscape, active]);
}
