import { useEffect, useMemo, useRef, useState } from 'react';
import { onFlyoverProgress, scrubFlyover } from '../lib/flyover';
import { type LonLatEle, nearestIndex } from '../lib/geo';
import { tNow } from '../lib/i18n';
import { kindDef, kindLabelKey, type PointKind } from '../lib/points';
import { slopeColorForDeg } from '../lib/slopeTiles';
import { usePlanner } from '../store';

const PAD = { top: 22, right: 14, bottom: 22, left: 46 };
// slope smoothing window: DEM noise would give every segment a different color
const SLOPE_WINDOW_M = 60;

export interface ProfilePoi {
  /** id of the route anchor behind the marker, so the chart can edit and move it */
  id: string;
  distM: number;
  kind: PointKind;
  name: string;
}

export interface ProfileSelection {
  fromM: number;
  toM: number;
}

export function ProfileChart({
  coords,
  dists,
  pois,
  selection,
  onSelectionChange,
}: {
  coords: LonLatEle[];
  dists: number[];
  pois: ProfilePoi[];
  selection: ProfileSelection | null;
  onSelectionChange: (selection: ProfileSelection | null) => void;
}) {
  const setHoverPoint = usePlanner(s => s.setHoverPoint);
  const flyover = usePlanner(s => s.flyover);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 130 });
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const dragFromMRef = useRef<number | null>(null);
  const draggedRef = useRef(false);
  const scrubbingRef = useRef(false);
  const progressRef = useRef<SVGGElement>(null);
  const poiRefs = useRef(new Map<number, SVGGElement>());
  const [poiDrag, setPoiDrag] = useState<{ id: string; distM: number; moved: boolean } | null>(null);
  const poiDragBoundsRef = useRef<{ fromM: number; toM: number }>({ fromM: 0, toM: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const totalM = dists[dists.length - 1];
  const elevations = coords.map(c => c[2]);
  let eleMin = Math.min(...elevations);
  let eleMax = Math.max(...elevations);
  if (eleMax - eleMin < 50) {
    const mid = (eleMin + eleMax) / 2;
    eleMin = mid - 25;
    eleMax = mid + 25;
  }

  const { x, y, plotW, plotH } = makeScales(size.w, size.h, totalM, eleMin, eleMax);

  // smoothed signed slope at each point (degrees)
  const slopes = useMemo(() => {
    return coords.map((_, i) => {
      const j1 = nearestIndex(dists, dists[i] - SLOPE_WINDOW_M);
      const j2 = nearestIndex(dists, dists[i] + SLOPE_WINDOW_M);
      const dd = dists[j2] - dists[j1];
      if (dd < 1) return 0;
      return (Math.atan((coords[j2][2] - coords[j1][2]) / dd) * 180) / Math.PI;
    });
  }, [coords, dists]);

  // line runs grouped by slope color, plus the neutral area below
  const { runs, areaPath } = useMemo(() => {
    const scales = makeScales(size.w, size.h, totalM, eleMin, eleMax);
    const point = (i: number) => `${scales.x(dists[i]).toFixed(1)},${scales.y(coords[i][2]).toFixed(1)}`;
    const runList: { color: string; d: string }[] = [];
    let current: { color: string; d: string } | null = null;
    let line = `M${point(0)}`;
    for (let i = 1; i < coords.length; i++) {
      const color = slopeColorForDeg((slopes[i - 1] + slopes[i]) / 2);
      if (!current || current.color !== color) {
        if (current) runList.push(current);
        current = { color, d: `M${point(i - 1)}L${point(i)}` };
      } else {
        current.d += `L${point(i)}`;
      }
      line += `L${point(i)}`;
    }
    if (current) runList.push(current);
    const baseline = PAD.top + scales.plotH;
    return {
      runs: runList,
      areaPath: `${line}L${scales.x(totalM).toFixed(1)},${baseline}L${PAD.left},${baseline}Z`,
    };
  }, [coords, dists, slopes, size.w, size.h, totalM, eleMin, eleMax]);

  const yTicks = niceTicks(eleMin, eleMax, 3);
  const xTicks = niceTicks(0, totalM / 1000, 5);

  // the flying dot mirrored on the profile, moved imperatively: a React render per camera
  // frame would reconcile the whole SVG sixty times a second for one moving circle
  useEffect(() => {
    const marker = progressRef.current;
    if (!flyover || !marker) return;
    const { x: sx, y: sy } = makeScales(size.w, size.h, totalM, eleMin, eleMax);
    let prevM: number | null = null;
    marker.style.display = 'none';
    const off = onFlyoverProgress(distM => {
      const index = nearestIndex(dists, distM);
      marker.setAttribute('transform', `translate(${sx(dists[index])},${sy(coords[index][2])})`);
      marker.style.display = '';
      // a crossed annotated point gets a little bounce, both ways so scrubbing pops them too
      if (prevM !== null) {
        const from = Math.min(prevM, distM);
        const to = Math.max(prevM, distM);
        for (const p of pois) {
          if (p.distM > from && p.distM <= to) {
            const el = poiRefs.current.get(p.distM);
            if (el) {
              el.classList.remove('poi-hit');
              requestAnimationFrame(() => el.classList.add('poi-hit'));
            }
          }
        }
      }
      prevM = distM;
    });
    return () => {
      off();
      marker.style.display = 'none';
    };
  }, [flyover, dists, coords, pois, size.w, size.h, totalM, eleMin, eleMax]);

  function eventDistM(e: { clientX: number; currentTarget: Element }): number {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    return Math.min(Math.max(ratio, 0), 1) * totalM;
  }

  /** distance under an arbitrary clientX, for handlers not attached to the interaction rect */
  function clientXToDistM(clientX: number): number {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = (clientX - rect.left - PAD.left) / Math.max(plotW, 1);
    return Math.min(Math.max(ratio, 0), 1) * totalM;
  }

  function beginPoiDrag(e: React.PointerEvent<SVGCircleElement>, poi: ProfilePoi) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    // sliding a point along the route must not cross its neighbors, the anchors stay ordered
    const { anchors, legs } = usePlanner.getState();
    const index = anchors.findIndex(a => a.id === poi.id);
    const cum: number[] = [0];
    for (let i = 0; i < legs.length; i++) cum.push(cum[i] + (legs[i]?.leg?.distanceM ?? 0));
    const margin = totalM * 0.005;
    poiDragBoundsRef.current = {
      fromM: index > 0 ? cum[index - 1] + margin : 0,
      toM: index < anchors.length - 1 ? cum[index + 1] - margin : totalM,
    };
    setPoiDrag({ id: poi.id, distM: poi.distM, moved: false });
  }

  function onPoiDragMove(e: React.PointerEvent<SVGCircleElement>) {
    if (!poiDrag) return;
    const bounds = poiDragBoundsRef.current;
    const distM = Math.min(Math.max(clientXToDistM(e.clientX), bounds.fromM), bounds.toM);
    const moved = poiDrag.moved || Math.abs(distM - poiDrag.distM) > totalM * 0.004;
    setPoiDrag({ ...poiDrag, distM, moved });
  }

  function endPoiDrag() {
    if (!poiDrag) return;
    const { anchors, moveAnchor, setEditing } = usePlanner.getState();
    const index = anchors.findIndex(a => a.id === poiDrag.id);
    if (index >= 0) {
      if (poiDrag.moved) {
        // snap to the route point under the released position: the point stays on the trail
        const i = nearestIndex(dists, poiDrag.distM);
        moveAnchor(index, [coords[i][0], coords[i][1]]);
      } else {
        setEditing(poiDrag.id);
      }
    }
    setPoiDrag(null);
  }

  function onChartDoubleClick(e: React.MouseEvent<SVGRectElement>) {
    if (flyover) return;
    const i = nearestIndex(dists, eventDistM(e));
    const state = usePlanner.getState();
    const before = new Set(state.anchors.map(a => a.id));
    if (!state.insertAnchor([coords[i][0], coords[i][1]])) return;
    // open the editor of the point that was just born, ready to become a summit or a spring
    const added = usePlanner.getState().anchors.find(a => !before.has(a.id));
    if (added) usePlanner.getState().setEditing(added.id);
  }

  function onPointerDown(e: React.PointerEvent<SVGRectElement>) {
    // capture so a drag keeps scrubbing or selecting outside the chart
    e.currentTarget.setPointerCapture(e.pointerId);
    if (flyover) {
      // touching the profile takes over playback: the play view switches to manual
      usePlanner.getState().setFlyoverPaused(true);
      scrubbingRef.current = true;
      scrubFlyover(eventDistM(e));
      return;
    }
    dragFromMRef.current = eventDistM(e);
    draggedRef.current = false;
  }

  function onPointerMove(e: React.PointerEvent<SVGRectElement>) {
    const distM = eventDistM(e);
    if (flyover) {
      if (scrubbingRef.current) scrubFlyover(distM);
      return;
    }
    const index = nearestIndex(dists, distM);
    setHoverIndex(index);
    setHoverPoint([coords[index][0], coords[index][1]]);
    const from = dragFromMRef.current;
    if (from !== null && Math.abs(distM - from) > totalM * 0.003) {
      draggedRef.current = true;
      onSelectionChange({ fromM: Math.min(from, distM), toM: Math.max(from, distM) });
    }
  }

  function onPointerUp() {
    scrubbingRef.current = false;
    if (flyover) return;
    // a plain click (no drag) clears the selection
    if (dragFromMRef.current !== null && !draggedRef.current) onSelectionChange(null);
    dragFromMRef.current = null;
  }

  function onPointerLeave() {
    dragFromMRef.current = null;
    setHoverIndex(null);
    setHoverPoint(null);
  }

  const hover = hoverIndex === null ? null : { cx: x(dists[hoverIndex]), cy: y(coords[hoverIndex][2]) };
  const hoverPct = hoverIndex === null ? 0 : Math.tan((slopes[hoverIndex] * Math.PI) / 180) * 100;

  return (
    <div ref={containerRef} className="chart-area">
      <svg width={size.w} height={size.h} role="img" aria-label={tNow('profile_title')}>
        <title>{tNow('profile_title')}</title>
        {selection && (
          <rect
            className="viz-selection"
            x={x(selection.fromM)}
            y={PAD.top}
            width={Math.max(x(selection.toM) - x(selection.fromM), 0)}
            height={Math.max(plotH, 0)}
          />
        )}
        {yTicks.map(t => (
          <g key={t}>
            <line x1={PAD.left} x2={size.w - PAD.right} y1={y(t)} y2={y(t)} className="viz-grid" />
            <text x={PAD.left - 6} y={y(t) + 3} className="viz-tick" textAnchor="end">
              {t} m
            </text>
          </g>
        ))}
        {xTicks.map(t => (
          <text key={t} x={x(t * 1000)} y={size.h - 6} className="viz-tick" textAnchor="middle">
            {t} km
          </text>
        ))}
        <path d={areaPath} className="viz-area" />
        {runs.map(r => (
          <path key={r.d.slice(0, 24)} d={r.d} className="viz-line-seg" stroke={r.color} />
        ))}
        {pois.map(p => {
          const dragged = poiDrag?.id === p.id ? poiDrag.distM : p.distM;
          const index = nearestIndex(dists, dragged);
          const def = kindDef(p.kind);
          const px = x(dists[index]);
          const py = y(coords[index][2]);
          return (
            <g
              key={`${p.distM}-${p.kind}-${p.name}`}
              className="viz-poi"
              ref={el => {
                if (el) poiRefs.current.set(p.distM, el);
                else poiRefs.current.delete(p.distM);
              }}
            >
              <line x1={px} x2={px} y1={py} y2={py - 12} />
              <text x={px} y={py - 15} textAnchor="middle">
                {def.emoji}
                <title>{p.name || tNow(kindLabelKey(p.kind))}</title>
              </text>
            </g>
          );
        })}
        <g ref={progressRef} className="viz-flyover-dot" style={{ display: 'none' }}>
          <circle r={8} className="viz-flyover-glow" />
          <circle r={3.5} className="viz-flyover-core" />
        </g>
        {hover && (
          <g>
            <line x1={hover.cx} x2={hover.cx} y1={PAD.top} y2={PAD.top + plotH} className="viz-crosshair" />
            <circle cx={hover.cx} cy={hover.cy} r={4} className="viz-dot" />
          </g>
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer-only enrichment, the numbers stay readable without it */}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={Math.max(plotW, 0)}
          height={Math.max(plotH, 0)}
          fill="transparent"
          style={{ touchAction: 'none' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
          onDoubleClick={onChartDoubleClick}
        />
        {/* hit targets above the interaction rect: click edits, a horizontal drag slides the
            point along the route (how a summit gets nudged onto the real summit) */}
        {!flyover &&
          pois.map(p => {
            const dragged = poiDrag?.id === p.id ? poiDrag.distM : p.distM;
            const index = nearestIndex(dists, dragged);
            return (
              <circle
                key={`hit-${p.id}`}
                className="viz-poi-hit"
                cx={x(dists[index])}
                cy={y(coords[index][2]) - 18}
                r={12}
                style={{ touchAction: 'none' }}
                onPointerDown={e => beginPoiDrag(e, p)}
                onPointerMove={onPoiDragMove}
                onPointerUp={endPoiDrag}
                onPointerCancel={endPoiDrag}
              />
            );
          })}
      </svg>
      {hover && hoverIndex !== null && (
        <div
          className="viz-tooltip"
          style={{ left: Math.min(hover.cx + 10, size.w - 170), top: Math.max(hover.cy - 34, 2) }}
        >
          {(dists[hoverIndex] / 1000).toFixed(1)} km · {Math.round(coords[hoverIndex][2])} m ·{' '}
          <span style={{ color: slopeColorForDeg(slopes[hoverIndex]) }}>
            {hoverPct >= 0 ? '+' : ''}
            {hoverPct.toFixed(0)} %
          </span>
        </div>
      )}
    </div>
  );
}

function makeScales(w: number, h: number, totalM: number, eleMin: number, eleMax: number) {
  const plotW = w - PAD.left - PAD.right;
  const plotH = h - PAD.top - PAD.bottom;
  const x = (m: number) => PAD.left + (m / totalM) * plotW;
  const y = (ele: number) => PAD.top + (1 - (ele - eleMin) / (eleMax - eleMin)) * plotH;
  return { x, y, plotW, plotH };
}

function niceTicks(min: number, max: number, targetCount: number): number[] {
  const range = max - min;
  if (range <= 0) return [Math.round(min)];
  const rawStep = range / targetCount;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = ([1, 2, 5, 10].find(m => m * magnitude >= rawStep) ?? 10) * magnitude;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) ticks.push(Number(t.toFixed(6)));
  return ticks;
}
