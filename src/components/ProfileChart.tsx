import { useEffect, useMemo, useRef, useState } from 'react';
import { type LonLatEle, nearestIndex } from '../lib/geo';
import { tNow } from '../lib/i18n';
import { kindDef, kindLabelKey, type PointKind } from '../lib/points';
import { slopeColorForDeg } from '../lib/slopeTiles';
import { usePlanner } from '../store';

const PAD = { top: 22, right: 14, bottom: 22, left: 46 };
// slope smoothing window: DEM noise would give every segment a different color
const SLOPE_WINDOW_M = 60;

export interface ProfilePoi {
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
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 130 });
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const dragFromMRef = useRef<number | null>(null);
  const draggedRef = useRef(false);

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

  function eventDistM(e: React.MouseEvent<SVGRectElement>): number {
    const rect = e.currentTarget.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * totalM;
  }

  function onMouseDown(e: React.MouseEvent<SVGRectElement>) {
    dragFromMRef.current = eventDistM(e);
    draggedRef.current = false;
  }

  function onMouseMove(e: React.MouseEvent<SVGRectElement>) {
    const distM = eventDistM(e);
    const index = nearestIndex(dists, distM);
    setHoverIndex(index);
    setHoverPoint([coords[index][0], coords[index][1]]);
    const from = dragFromMRef.current;
    if (from !== null && Math.abs(distM - from) > totalM * 0.003) {
      draggedRef.current = true;
      onSelectionChange({ fromM: Math.min(from, distM), toM: Math.max(from, distM) });
    }
  }

  function onMouseUp() {
    // a plain click (no drag) clears the selection
    if (dragFromMRef.current !== null && !draggedRef.current) onSelectionChange(null);
    dragFromMRef.current = null;
  }

  function onMouseLeave() {
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
          const index = nearestIndex(dists, p.distM);
          const def = kindDef(p.kind);
          const px = x(dists[index]);
          const py = y(coords[index][2]);
          return (
            <g key={`${p.distM}-${p.kind}-${p.name}`} className="viz-poi">
              <line x1={px} x2={px} y1={py} y2={py - 12} />
              <text x={px} y={py - 15} textAnchor="middle">
                {def.emoji}
                <title>{p.name || tNow(kindLabelKey(p.kind))}</title>
              </text>
            </g>
          );
        })}
        {hover && (
          <g>
            <line x1={hover.cx} x2={hover.cx} y1={PAD.top} y2={PAD.top + plotH} className="viz-crosshair" />
            <circle cx={hover.cx} cy={hover.cy} r={4} className="viz-dot" />
          </g>
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer hover only, purely visual enrichment */}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={Math.max(plotW, 0)}
          height={Math.max(plotH, 0)}
          fill="transparent"
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseLeave}
        />
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
