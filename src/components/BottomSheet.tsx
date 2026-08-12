import { type ReactNode, type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';

/** peek shows the stats strip, half the profile and the actions, full the whole panel */
export type SheetStop = 'peek' | 'half' | 'full';

const STOPS: SheetStop[] = ['peek', 'half', 'full'];
/** a drag shorter than this is a tap, not an intent to move the sheet */
const DRAG_THRESHOLD_PX = 24;

export function BottomSheet({
  stop,
  onStopChange,
  header,
  children,
}: {
  stop: SheetStop;
  onStopChange: (stop: SheetStop) => void;
  header: ReactNode;
  children: ReactNode;
}) {
  const dragStartRef = useRef<number | null>(null);
  const [dragOffset, setDragOffset] = useState(0);

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    dragStartRef.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (dragStartRef.current === null) return;
    setDragOffset(e.clientY - dragStartRef.current);
  }

  function onPointerUp() {
    const offset = dragOffset;
    dragStartRef.current = null;
    setDragOffset(0);
    if (Math.abs(offset) < DRAG_THRESHOLD_PX) return;
    // dragging down goes to a smaller stop, up to a taller one
    const next = STOPS.indexOf(stop) + (offset > 0 ? -1 : 1);
    onStopChange(STOPS[Math.min(STOPS.length - 1, Math.max(0, next))]);
  }

  return (
    <section
      className={`sheet sheet-${stop}`}
      style={dragOffset ? { transform: `translateY(${Math.max(0, dragOffset)}px)`, transition: 'none' } : undefined}
      aria-label="panel"
    >
      <div className="sheet-grip" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
        <span className="sheet-grip-bar" />
      </div>
      <div className="sheet-header">
        {header}
        <div className="sheet-stops">
          {STOPS.map(candidate => (
            <button
              key={candidate}
              type="button"
              className={candidate === stop ? 'sheet-stop on' : 'sheet-stop'}
              aria-label={candidate}
              onClick={() => onStopChange(candidate)}
            />
          ))}
        </div>
      </div>
      <div className="sheet-body">{children}</div>
    </section>
  );
}
