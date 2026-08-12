import { type ReactNode, type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';

/** peek shows the stats strip, half adds the profile, full the whole panel */
export type SheetStop = 'peek' | 'half' | 'full';

const STOPS: SheetStop[] = ['peek', 'half', 'full'];
/** below this the gesture was a tap, not a drag */
const TAP_SLOP_PX = 10;
/** heights must match the css stops, the drag snaps against them */
const STOP_RATIOS: Record<SheetStop, number> = { peek: 0, half: 0.46, full: 0.88 };
const PEEK_PX = 88;

function stopHeight(stop: SheetStop, viewportHeight: number): number {
  return stop === 'peek' ? PEEK_PX : Math.round(viewportHeight * STOP_RATIOS[stop]);
}

function nearestStop(height: number, viewportHeight: number): SheetStop {
  return STOPS.reduce((best, stop) =>
    Math.abs(stopHeight(stop, viewportHeight) - height) < Math.abs(stopHeight(best, viewportHeight) - height)
      ? stop
      : best,
  );
}

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
  const sheetRef = useRef<HTMLElement>(null);
  const dragRef = useRef<{ y: number; height: number; moved: boolean } | null>(null);
  // set only while a finger is down, so the sheet follows it instead of animating between stops
  const [dragHeight, setDragHeight] = useState<number | null>(null);

  function onPointerDown(e: ReactPointerEvent<HTMLElement>) {
    const height = sheetRef.current?.getBoundingClientRect().height ?? PEEK_PX;
    dragRef.current = { y: e.clientY, height, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = drag.y - e.clientY;
    if (Math.abs(delta) > TAP_SLOP_PX) drag.moved = true;
    if (!drag.moved) return;
    const max = stopHeight('full', window.innerHeight);
    setDragHeight(Math.min(max, Math.max(PEEK_PX, drag.height + delta)));
  }

  function onPointerUp() {
    const drag = dragRef.current;
    dragRef.current = null;
    const height = dragHeight;
    setDragHeight(null);
    if (!drag) return;
    // a tap cycles the stops, which beats asking for a precise drag on a phone
    if (!drag.moved || height === null) {
      onStopChange(STOPS[(STOPS.indexOf(stop) + 1) % STOPS.length]);
      return;
    }
    onStopChange(nearestStop(height, window.innerHeight));
  }

  return (
    <section
      ref={sheetRef}
      className={`sheet sheet-${stop}`}
      style={dragHeight === null ? undefined : { height: `${dragHeight}px`, transition: 'none' }}
      aria-label="panel"
    >
      <div
        className="sheet-grip"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
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
              aria-pressed={candidate === stop}
              onClick={() => onStopChange(candidate)}
            />
          ))}
        </div>
      </div>
      <div className="sheet-body">{children}</div>
    </section>
  );
}
