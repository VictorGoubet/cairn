import { Fragment, useMemo, useState } from 'react';
import type { RoutingPreset } from '../lib/brouter';
import { elevationStats, formatDistance } from '../lib/geo';
import { type MsgKey, useT } from '../lib/i18n';
import { kindDef, kindLabelKey } from '../lib/points';
import { type Anchor, isClosedRoute, usePlanner } from '../store';

const ROUTING_PRESETS: readonly RoutingPreset[] = ['balanced', 'shortest', 'fastest', 'avoid_roads', 'easy_up'];

export function Sidebar() {
  const t = useT();
  // reordering by drag: dragIndex is the point being moved, dropIndex the slot under the cursor
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  function endDrag() {
    setDragIndex(null);
    setDropIndex(null);
  }

  const manualMode = usePlanner(s => s.manualMode);
  const routingPreset = usePlanner(s => s.routingPreset);
  const anchors = usePlanner(s => s.anchors);
  const legs = usePlanner(s => s.legs);
  const offRoutePoints = usePlanner(s => s.offRoutePoints);
  const history = usePlanner(s => s.history);
  const future = usePlanner(s => s.future);
  const hasRoute = legs.some(l => (l.leg?.coords.length ?? 0) > 0);
  const isLoop = isClosedRoute(anchors);
  // a leg stays manual when it was imported as a beeline or drawn in manual mode
  const hasStraightLegs = legs.some(l => l.manual);

  // what is still ahead from each point: suffix sums over the legs, refreshed with them
  const remaining = useMemo(() => {
    const out: ({ distanceM: number; gainM: number; lossM: number } | null)[] = Array(legs.length + 1).fill(null);
    let acc: { distanceM: number; gainM: number; lossM: number } | null = { distanceM: 0, gainM: 0, lossM: 0 };
    for (let i = legs.length - 1; i >= 0; i--) {
      const leg = legs[i].leg;
      // a leg still computing poisons every suffix behind it: show nothing rather than a lie
      acc =
        leg && acc
          ? {
              distanceM: acc.distanceM + leg.distanceM,
              gainM: acc.gainM + elevationStats(leg.coords).gainM,
              lossM: acc.lossM + elevationStats(leg.coords).lossM,
            }
          : null;
      out[i] = acc;
    }
    return out;
  }, [legs]);

  function legLabel(index: number): string {
    const slot = legs[index];
    if (!slot?.leg) return t('computing');
    const straight = slot.manual && slot.leg.coords.length === 2;
    return straight
      ? `${formatDistance(slot.leg.distanceM)} · ${t('leg_straight')}`
      : formatDistance(slot.leg.distanceM);
  }

  function anchorLabel(anchor: Anchor, index: number): string {
    if (anchor.name) return anchor.name;
    if (anchor.kind !== 'checkpoint') return t(kindLabelKey(anchor.kind));
    if (index === 0) return t('start');
    if (index === anchors.length - 1 && anchors.length > 1) return t('end');
    return `${t('point')} ${index + 1}`;
  }

  return (
    <aside className="side">
      <section className="side-section">
        <h2>{t('section_route')}</h2>
        <p className="side-label">{t('trace_type')}</p>
        <div className="segmented">
          <button
            type="button"
            className={manualMode ? '' : 'on'}
            onClick={() => usePlanner.getState().setManualMode(false)}
          >
            {t('auto')}
          </button>
          <button
            type="button"
            className={manualMode ? 'on' : ''}
            onClick={() => usePlanner.getState().setManualMode(true)}
          >
            {t('manual')}
          </button>
        </div>
        <p className="side-hint">{manualMode ? t('manual_hint') : t('auto_hint')}</p>

        {!manualMode && (
          <>
            <p className="side-label">{t('routing_preset')}</p>
            <div className="segmented wrap">
              {ROUTING_PRESETS.map(preset => (
                <button
                  type="button"
                  key={preset}
                  className={routingPreset === preset ? 'on' : ''}
                  onClick={() => usePlanner.getState().setRoutingPreset(preset)}
                >
                  {t(`preset_${preset}` as MsgKey)}
                </button>
              ))}
            </div>
          </>
        )}

        {anchors.length === 0 ? (
          <p className="side-help">{t('start_help')}</p>
        ) : (
          <div className="side-actions">
            <div className="side-row icons">
              <button
                type="button"
                title={t('undo')}
                aria-label={t('undo')}
                disabled={history.length === 0}
                onClick={() => usePlanner.getState().undo()}
              >
                <Icon name="undo" />
              </button>
              <button
                type="button"
                title={t('redo')}
                aria-label={t('redo')}
                disabled={future.length === 0}
                onClick={() => usePlanner.getState().redo()}
              >
                <Icon name="redo" />
              </button>
            </div>
            <div className="side-row">
              <button type="button" disabled={!hasRoute} onClick={() => usePlanner.getState().reverse()}>
                <Icon name="reverse" />
                {t('reverse')}
              </button>
              <button type="button" disabled={!hasRoute || isLoop} onClick={() => usePlanner.getState().outAndBack()}>
                <Icon name="outAndBack" />
                {t('out_and_back')}
              </button>
            </div>
            <div className="side-row">
              {/* one button for the round trip: it closes the loop, then offers to open it again */}
              <button
                type="button"
                data-control="loop"
                disabled={!hasRoute}
                title={isLoop ? t('open_loop_hint') : undefined}
                onClick={() => (isLoop ? usePlanner.getState().openLoop() : usePlanner.getState().closeLoop())}
              >
                <Icon name={isLoop ? 'openLoop' : 'closeLoop'} />
                {isLoop ? t('open_loop') : t('close_loop')}
              </button>
              <button type="button" className="danger-ghost" onClick={() => usePlanner.getState().clear()}>
                <Icon name="clear" />
                {t('clear_route')}
              </button>
            </div>
            {hasStraightLegs && (
              <button
                type="button"
                className="side-wide"
                data-control="route-straight"
                title={t('route_straight_hint')}
                onClick={() => usePlanner.getState().routeStraightLegs()}
              >
                <Icon name="trails" />
                {t('route_straight')}
              </button>
            )}
          </div>
        )}
      </section>

      {anchors.length > 0 && (
        <section className="side-section">
          <h2>{t('route_points')}</h2>
          <ul className="poi-list anchor-list">
            {anchors.map((anchor, index) => (
              <Fragment key={anchor.id}>
                <li
                  className={dragIndex === index ? 'dragging' : dropIndex === index ? 'drop-target' : undefined}
                  draggable
                  onDragStart={() => setDragIndex(index)}
                  onDragEnd={endDrag}
                  onDragOver={e => {
                    e.preventDefault();
                    setDropIndex(index);
                  }}
                  onDrop={e => {
                    e.preventDefault();
                    if (dragIndex !== null) usePlanner.getState().reorderAnchor(dragIndex, index);
                    endDrag();
                  }}
                >
                  <span className="drag-handle" title={t('reorder_hint')} aria-hidden="true">
                    ⠿
                  </span>
                  <button
                    type="button"
                    className="wp-name"
                    title={t('center_edit')}
                    onClick={() => {
                      usePlanner.getState().setFlyTo({ center: [anchor.lon, anchor.lat], zoom: 14 });
                      usePlanner.getState().setEditing(anchor.id);
                    }}
                  >
                    <span
                      className={
                        index === 0
                          ? 'anchor-num start'
                          : index === anchors.length - 1 && anchors.length > 1
                            ? 'anchor-num end'
                            : 'anchor-num'
                      }
                    >
                      {index + 1}
                    </span>
                    {anchor.kind !== 'checkpoint' && `${kindDef(anchor.kind).emoji} `}
                    {anchorLabel(anchor, index)}
                    {remaining[index] && (
                      <span className="wp-remaining">
                        {t('remaining_short')} {formatDistance(remaining[index].distanceM)} · +
                        {Math.round(remaining[index].gainM)} m · -{Math.round(remaining[index].lossM)} m
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="wp-remove"
                    title={t('delete_point')}
                    onClick={() => usePlanner.getState().removeAnchor(anchor.id)}
                  >
                    ×
                  </button>
                </li>
                {/* the leg between two points, so its length and a way to delete it are visible
                  without knowing that the trace answers a long press */}
                {index < anchors.length - 1 && (
                  <li className="leg-row">
                    <button
                      type="button"
                      data-control="leg-row"
                      title={t('leg_open')}
                      onClick={() => usePlanner.getState().setEditingLeg(index)}
                    >
                      {legLabel(index)}
                    </button>
                  </li>
                )}
              </Fragment>
            ))}
          </ul>
        </section>
      )}

      <section className="side-section">
        <h2>{t('off_route_title')}</h2>
        {offRoutePoints.length === 0 ? (
          <p className="side-hint">{t('off_route_hint')}</p>
        ) : (
          <ul className="poi-list">
            {offRoutePoints.map(point => {
              const def = kindDef(point.kind);
              return (
                <li key={point.id}>
                  <button
                    type="button"
                    className="wp-name"
                    title={t('center_edit')}
                    onClick={() => {
                      usePlanner.getState().setFlyTo({ center: [point.lon, point.lat], zoom: 14 });
                      usePlanner.getState().setEditing(point.id);
                    }}
                  >
                    {def.emoji} {point.name || t(kindLabelKey(point.kind) as MsgKey)}
                  </button>
                  <button
                    type="button"
                    className="wp-remove"
                    title={t('delete')}
                    onClick={() => usePlanner.getState().removeOffRoutePoint(point.id)}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </aside>
  );
}

/**
 * The little 24x24 stroke icons of the route actions.
 *
 * Inline rather than a sprite: there are six of them, they inherit the button's color, and a
 * dependency for six paths would cost more than it saves.
 */
function Icon({ name }: { name: keyof typeof ICON_PATHS }) {
  return (
    <svg
      className="btn-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name].map(d => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

const ICON_PATHS = {
  undo: ['M4 10h9a5 5 0 1 1 0 10H8', 'M8 6 4 10l4 4'],
  redo: ['M20 10h-9a5 5 0 1 0 0 10h5', 'M16 6l4 4-4 4'],
  reverse: ['M7 8h11l-3-3', 'M17 16H6l3 3'],
  outAndBack: ['M5 12h14', 'M9 8l-4 4 4 4', 'M15 8l4 4-4 4'],
  closeLoop: ['M12 5a7 7 0 1 1-6.9 8.2', 'M9 3l3 2-3 2'],
  openLoop: ['M12 5a7 7 0 1 1-6.9 8.2', 'M9 3l3 2-3 2', 'M4 4l16 16'],
  clear: ['M5 7h14', 'M10 7V5h4v2', 'M7 7l1 12h8l1-12'],
  trails: ['M4 19c3.5 0 3-5 6.5-5S13 8 17 8h3', 'M17 5l3 3-3 3'],
} as const;
