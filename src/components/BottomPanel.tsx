import { type ReactNode, useEffect, useMemo } from 'react';
import { cumulativeDistancesM, elevationStats, formatDistance, formatDuration, nearestIndex } from '../lib/geo';
import { durationH, energyKcal } from '../lib/hikingTime';
import { type MsgKey, useT } from '../lib/i18n';
import { computeStages } from '../lib/stages';
import { aggregateBy, SURFACE_CATEGORIES, SURFACE_COLORS, sacStats, WAY_CATEGORIES, WAY_COLORS } from '../lib/waytypes';
import { routeCoords, routeDistanceM, usePlanner, type WayHighlight } from '../store';
import { ProfileChart } from './ProfileChart';
import { StagesPanel } from './StagesPanel';

export function BottomPanel() {
  const t = useT();
  const legs = usePlanner(s => s.legs);
  const anchors = usePlanner(s => s.anchors);
  const selection = usePlanner(s => s.profileSelection);
  const profile = usePlanner(s => s.profile);
  const setSelection = usePlanner(s => s.setProfileSelection);
  const coords = useMemo(() => routeCoords(legs), [legs]);
  const dists = useMemo(() => cumulativeDistancesM(coords), [coords]);
  const resolvedLegs = useMemo(() => legs.map(l => l.leg), [legs]);
  const wayTotals = useMemo(() => aggregateBy(resolvedLegs, 'category'), [resolvedLegs]);
  const surfaceTotals = useMemo(() => aggregateBy(resolvedLegs, 'surface'), [resolvedLegs]);
  const sac = useMemo(() => sacStats(resolvedLegs), [resolvedLegs]);
  const stages = useMemo(() => computeStages(anchors, legs, profile), [anchors, legs, profile]);
  // the distribution only makes sense if at least one routed leg provided it
  const hasWayTypes = WAY_CATEGORIES.some(c => c !== 'unknown' && (wayTotals[c] ?? 0) > 0);

  // the selection becomes meaningless when the track changes
  // biome-ignore lint/correctness/useExhaustiveDependencies(coords): intentional trigger, not a value we read
  useEffect(() => setSelection(null), [coords, setSelection]);

  // route POIs projected onto their cumulative distance along the itinerary
  const pois = useMemo(() => {
    const out: { id: string; distM: number; kind: (typeof anchors)[number]['kind']; name: string }[] = [];
    let cum = 0;
    anchors.forEach((a, i) => {
      if (i > 0) cum += legs[i - 1]?.leg?.distanceM ?? 0;
      if (a.kind !== 'checkpoint') out.push({ id: a.id, distM: cum, kind: a.kind, name: a.name });
    });
    return out;
  }, [anchors, legs]);

  if (coords.length < 2) return null;

  // stats over the profile selection when there is one, otherwise over the whole itinerary
  let statsCoords = coords;
  let distanceM = routeDistanceM(legs);
  if (selection) {
    const j1 = nearestIndex(dists, selection.fromM);
    const j2 = nearestIndex(dists, selection.toM);
    statsCoords = coords.slice(Math.min(j1, j2), Math.max(j1, j2) + 1);
    distanceM = Math.abs(dists[j2] - dists[j1]);
  }
  const { gainM, lossM } = elevationStats(statsCoords);
  const elevations = statsCoords.map(c => c[2]);
  const routing = legs.some(l => !l.leg);

  const stats: [string, string][] = [
    [t('distance'), formatDistance(distanceM)],
    [t('dplus'), `${Math.round(gainM)} m`],
    [t('dminus'), `${Math.round(lossM)} m`],
    [t('alt_min'), `${Math.round(Math.min(...elevations))} m`],
    [t('alt_max'), `${Math.round(Math.max(...elevations))} m`],
    [t('duration_est'), formatDuration(durationH(statsCoords, profile))],
    [t('energy_est'), `${Math.round(energyKcal(statsCoords, profile))} kcal`],
  ];

  return (
    <div className="bottom-panel">
      <div className="stats-row">
        {stats.map(([label, value]) => (
          <div key={label} className="stat">
            <span className="stat-value">{value}</span>
            <span className="stat-label">{label}</span>
          </div>
        ))}
        {selection && (
          <button
            type="button"
            className="selection-chip"
            title={t('clear_selection')}
            onClick={() => setSelection(null)}
          >
            {t('selection')} ×
          </button>
        )}
        {routing && <span className="routing-note">{t('computing')}</span>}
      </div>
      {hasWayTypes && (
        <div className="waytype-rows">
          <DistributionBar
            dim="category"
            label={t('ways_short')}
            title={t('way_types')}
            categories={WAY_CATEGORIES.filter(c => (wayTotals[c] ?? 0) > 0)}
            totals={wayTotals}
            colors={WAY_COLORS}
            labelPrefix="wt_"
          />
          <DistributionBar
            dim="surface"
            label={t('surfaces')}
            title={t('surfaces')}
            categories={SURFACE_CATEGORIES.filter(c => (surfaceTotals[c] ?? 0) > 0)}
            totals={surfaceTotals}
            colors={SURFACE_COLORS}
            labelPrefix="sf_"
            trailing={
              sac.maxSac >= 3 ? (
                <span className="sac-warning" title={t('sac_warning_hint')}>
                  ⚠ {t('sac_warning')} T{sac.maxSac} · {formatDistance(sac.warningDistanceM)}
                </span>
              ) : undefined
            }
          />
        </div>
      )}
      {stages.length > 0 && <StagesPanel stages={stages} />}
      <ProfileChart coords={coords} dists={dists} pois={pois} selection={selection} onSelectionChange={setSelection} />
    </div>
  );
}

// stacked bar + legend; hovering a category highlights it on the map
function DistributionBar({
  dim,
  label,
  title,
  categories,
  totals,
  colors,
  labelPrefix,
  trailing,
}: {
  dim: WayHighlight['dim'];
  label: string;
  title: string;
  categories: readonly string[];
  totals: Record<string, number>;
  colors: Record<string, string>;
  labelPrefix: 'wt_' | 'sf_';
  trailing?: ReactNode;
}) {
  const t = useT();
  const highlight = (value: string | null) =>
    usePlanner.getState().setWayTypeHighlight(value === null ? null : { dim, value });
  return (
    <div className="waytype-row" title={title}>
      <span className="waytype-title">{label}</span>
      <div className="waytype-bar">
        {categories.map(c => (
          // biome-ignore lint/a11y/noStaticElementInteractions: purely decorative hover, the legend stays readable without it
          <span
            key={c}
            className="waytype-seg"
            style={{ flexGrow: totals[c], background: colors[c] }}
            onMouseEnter={() => highlight(c)}
            onMouseLeave={() => highlight(null)}
          />
        ))}
      </div>
      <div className="waytype-legend">
        {categories.map(c => (
          // biome-ignore lint/a11y/noStaticElementInteractions: purely decorative hover, the legend stays readable without it
          <span key={c} className="waytype-item" onMouseEnter={() => highlight(c)} onMouseLeave={() => highlight(null)}>
            <span className="waytype-dot" style={{ background: colors[c] }} />
            {t(`${labelPrefix}${c}` as MsgKey)} · {formatDistance(totals[c])}
          </span>
        ))}
        {trailing}
      </div>
    </div>
  );
}
