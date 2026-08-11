import { useRef } from 'react';
import { useT } from '../lib/i18n';
import { kindLabelKey, POINT_KINDS } from '../lib/points';
import { useClickOutside } from '../lib/useClickOutside';
import { usePlanner } from '../store';

function closeEditor() {
  usePlanner.getState().setEditing(null);
}

export function PointEditor() {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const editing = usePlanner(s => s.editing);
  useClickOutside(rootRef, closeEditor, editing !== null);
  const anchors = usePlanner(s => s.anchors);
  const offRoutePoints = usePlanner(s => s.offRoutePoints);

  if (!editing) return null;
  const point = anchors.find(a => a.id === editing) ?? offRoutePoints.find(w => w.id === editing);
  if (!point) return null;

  // départ et arrivée sont des rôles de position (1er/dernier point), reflétés ici sans être des types stockés
  const anchorIndex = anchors.findIndex(a => a.id === editing);
  const isOffRoute = anchorIndex < 0;
  const isStart = anchorIndex === 0;
  const isEnd = anchorIndex === anchors.length - 1 && anchors.length > 1;

  // un repère hors tracé n'est jamais un checkpoint du parcours
  const kinds = (isOffRoute ? POINT_KINDS.filter(k => k.id !== 'checkpoint') : POINT_KINDS).map(k => {
    const label = t(kindLabelKey(k.id));
    if (k.id !== 'checkpoint') return { ...k, label };
    if (isStart) return { ...k, label: t('start'), emoji: '🟢' };
    if (isEnd) return { ...k, label: t('end'), emoji: '🔴' };
    return { ...k, label };
  });

  const title = isOffRoute
    ? t('off_route_point')
    : isStart
      ? t('start')
      : isEnd
        ? t('end')
        : point.kind !== 'checkpoint'
          ? t('poi')
          : t('point_of_route');

  return (
    <div className="point-editor" ref={rootRef}>
      <div className="point-editor-head">
        <h2>{title}</h2>
        <button
          type="button"
          className="editor-close"
          title={t('close')}
          onClick={() => usePlanner.getState().setEditing(null)}
        >
          ×
        </button>
      </div>

      <div className="kind-grid">
        {kinds.map(k => (
          <button
            key={k.id}
            type="button"
            className={k.id === point.kind ? 'kind-option selected' : 'kind-option'}
            style={{ '--kind-color': k.color } as React.CSSProperties}
            onClick={() => usePlanner.getState().updateEditingPoint(k.id, point.name)}
          >
            <span className="kind-emoji">{k.emoji}</span>
            {k.label}
          </button>
        ))}
      </div>

      {point.kind !== 'checkpoint' && (
        <input
          type="text"
          className="point-name"
          placeholder={t('name_placeholder')}
          value={point.name}
          onChange={e => usePlanner.getState().updateEditingPoint(point.kind, e.target.value)}
        />
      )}

      <div className="point-editor-actions">
        <button type="button" className="danger" onClick={() => usePlanner.getState().removeEditingPoint()}>
          {t('delete_point')}
        </button>
        <button type="button" className="primary" onClick={() => usePlanner.getState().setEditing(null)}>
          {t('ok')}
        </button>
      </div>
    </div>
  );
}
