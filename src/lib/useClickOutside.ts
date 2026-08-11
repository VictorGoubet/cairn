import { type RefObject, useEffect } from 'react';

/** ferme un widget flottant dès qu'on interagit ailleurs (capture, avant les handlers de la carte) */
export function useClickOutside(ref: RefObject<HTMLElement | null>, onOutside: () => void, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [ref, onOutside, active]);
}
