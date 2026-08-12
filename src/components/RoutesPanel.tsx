import { useState } from 'react';
import { formatDistance } from '../lib/geo';
import { useT } from '../lib/i18n';
import { dateLocale } from '../lib/lang';
import { usePlanner } from '../store';

export function RoutesPanel() {
  const t = useT();
  const lang = usePlanner(s => s.lang);
  const showRoutes = usePlanner(s => s.showRoutes);
  const savedRoutes = usePlanner(s => s.savedRoutes);
  const currentRouteId = usePlanner(s => s.currentRouteId);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  if (!showRoutes) return null;

  // first click arms the confirmation, second click deletes: no native dialog
  function remove(id: string) {
    if (confirmId === id) {
      usePlanner.getState().deleteRoute(id);
      setConfirmId(null);
    } else {
      setConfirmId(id);
    }
  }

  return (
    <aside className="routes-panel">
      {savedRoutes.length === 0 && <p className="routes-empty">{t('no_routes')}</p>}
      <ul>
        {savedRoutes.map(r => (
          <li key={r.id} className={r.id === currentRouteId ? 'active' : undefined}>
            <button
              type="button"
              className="route-load"
              title={t('load')}
              onClick={() => usePlanner.getState().loadRoute(r.id)}
            >
              <span className="route-name">{r.name}</span>
              <span className="route-meta">
                {formatDistance(r.distanceM)} · {Math.round(r.gainM)} m D+ ·{' '}
                {new Date(r.updatedAt).toLocaleDateString(dateLocale(lang))}
              </span>
            </button>
            <button
              type="button"
              className={confirmId === r.id ? 'route-remove armed' : 'route-remove'}
              title={t('delete')}
              onBlur={() => setConfirmId(null)}
              onClick={() => remove(r.id)}
            >
              {confirmId === r.id ? t('confirm') : '×'}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
