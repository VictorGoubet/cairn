import { useState } from 'react';
import type { RoutingPreset } from '../lib/brouter';
import { type MsgKey, useT } from '../lib/i18n';
import { kindDef, kindLabelKey } from '../lib/points';
import { type Anchor, isClosedRoute, usePlanner } from '../store';

const ROUTING_PRESETS: readonly RoutingPreset[] = ['balanced', 'avoid_roads', 'easy_up'];

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
            <div className="segmented">
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
            <div className="side-row">
              <button
                type="button"
                title={t('undo')}
                disabled={history.length === 0}
                onClick={() => usePlanner.getState().undo()}
              >
                ↶
              </button>
              <button
                type="button"
                title={t('redo')}
                disabled={future.length === 0}
                onClick={() => usePlanner.getState().redo()}
              >
                ↷
              </button>
            </div>
            <div className="side-row">
              <button type="button" disabled={!hasRoute} onClick={() => usePlanner.getState().reverse()}>
                {t('reverse')}
              </button>
              <button type="button" disabled={!hasRoute || isLoop} onClick={() => usePlanner.getState().outAndBack()}>
                {t('out_and_back')}
              </button>
            </div>
            <div className="side-row">
              <button type="button" disabled={!hasRoute || isLoop} onClick={() => usePlanner.getState().closeLoop()}>
                {t('close_loop')}
              </button>
              <button type="button" onClick={() => usePlanner.getState().clear()}>
                {t('clear_route')}
              </button>
            </div>
          </div>
        )}
      </section>

      {anchors.length > 0 && (
        <section className="side-section">
          <h2>{t('route_points')}</h2>
          <ul className="poi-list anchor-list">
            {anchors.map((anchor, index) => (
              <li
                key={anchor.id}
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
