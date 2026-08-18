import { useRef } from 'react';
import { formatDistance } from '../lib/geo';
import { type MsgKey, useT } from '../lib/i18n';
import { kindLabelKey } from '../lib/points';
import { useClickOutside } from '../lib/useClickOutside';
import { useEscapeKey } from '../lib/useEscapeKey';
import { type Anchor, usePlanner } from '../store';

function closeEditor() {
  usePlanner.getState().setEditingLeg(null);
}

/**
 * Panel acting on one leg of the route, opened from the trace (right click, long press) or from
 * the point list.
 *
 * A leg cannot simply be removed: taken out of the middle it would leave two disjoint
 * itineraries, which the one-route model cannot hold. So deleting one is offered as a choice of
 * the half that survives, the same cut the point editor performs, reached from the line the
 * hiker is actually looking at.
 */
export function LegEditor() {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const index = usePlanner(s => s.editingLeg);
  const legs = usePlanner(s => s.legs);
  const anchors = usePlanner(s => s.anchors);
  useClickOutside(rootRef, closeEditor, index !== null);
  useEscapeKey(closeEditor, index !== null);

  if (index === null) return null;
  const slot = legs[index];
  const from = anchors[index];
  const to = anchors[index + 1];
  if (!slot || !from || !to) return null;

  const trim = usePlanner.getState().trimRoute;
  // trimming must leave at least two anchors, so an edge leg can only be cut from one side
  const canKeepStart = index > 0;
  const canKeepEnd = index < anchors.length - 2;
  const straight = slot.manual && (slot.leg?.coords.length ?? 0) === 2;

  return (
    <div className="point-editor" ref={rootRef}>
      <div className="point-editor-head">
        <h2>
          {t('leg')} {index + 1}
        </h2>
        <button type="button" className="editor-close" title={t('close')} onClick={closeEditor}>
          ×
        </button>
      </div>

      <p className="editor-ends">
        {label(from, t)} → {label(to, t)}
      </p>
      <p className="editor-ends">
        {formatDistance(slot.leg?.distanceM ?? 0)}
        {straight && ` · ${t('leg_straight')}`}
      </p>

      <div className="editor-trim">
        <span className="editor-trim-label">{t('leg_delete')}</span>
        <div className="side-row">
          <button
            type="button"
            data-control="leg-keep-start"
            disabled={!canKeepStart}
            title={t('trim_before_hint')}
            onClick={() => trim(from.id, 'before')}
          >
            {t('trim_before')}
          </button>
          <button
            type="button"
            data-control="leg-keep-end"
            disabled={!canKeepEnd}
            title={t('trim_after_hint')}
            onClick={() => trim(to.id, 'after')}
          >
            {t('trim_after')}
          </button>
        </div>
        <p className="side-hint">{t('leg_delete_hint')}</p>
      </div>
    </div>
  );
}

function label(anchor: Anchor, t: (key: MsgKey) => string): string {
  return anchor.name || t(kindLabelKey(anchor.kind));
}
