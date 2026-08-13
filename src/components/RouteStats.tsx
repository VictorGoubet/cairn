import { useMemo, useRef, useState } from 'react';
import { track } from '../lib/analytics';
import { elevationStats, formatDistance } from '../lib/geo';
import { useT } from '../lib/i18n';
import { dateLocale } from '../lib/lang';
import { useClickOutside } from '../lib/useClickOutside';
import { useEscapeKey } from '../lib/useEscapeKey';
import { routeCoords, routeDistanceM, usePlanner } from '../store';

/**
 * Distance, elevation gain and the save action.
 *
 * Shared by the floating card on desktop and the bottom sheet header on a phone, so the
 * numbers and the save flow cannot drift between the two layouts.
 */
export function RouteStats() {
  const t = useT();
  const lang = usePlanner(s => s.lang);
  const legs = usePlanner(s => s.legs);
  const currentRouteName = usePlanner(s => s.currentRouteName);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const saveWrapRef = useRef<HTMLDivElement>(null);
  useClickOutside(saveWrapRef, () => setSaveOpen(false), saveOpen);
  useEscapeKey(() => setSaveOpen(false), saveOpen);

  const coords = useMemo(() => routeCoords(legs), [legs]);
  const gainM = useMemo(() => (coords.length ? elevationStats(coords).gainM : 0), [coords]);
  const hasRoute = coords.length >= 2;

  function openSave() {
    setSaveName(currentRouteName || `${t('route_of')} ${new Date().toLocaleDateString(dateLocale(lang))}`);
    setSaveOpen(true);
  }

  function confirmSave() {
    const name = saveName.trim();
    if (!name) return;
    track('save-route', { distanceKm: Math.round(routeDistanceM(legs) / 1000) });
    usePlanner.getState().saveCurrentRoute(name);
    setSaveOpen(false);
  }

  return (
    <>
      <div className="stats-card-item">
        <span className="stat-label">{t('distance')}</span>
        <span className="stat-value">{hasRoute ? formatDistance(routeDistanceM(legs)) : '0 km'}</span>
      </div>
      <div className="stats-card-item">
        <span className="stat-label">{t('dplus')}</span>
        <span className="stat-value">{hasRoute ? `${Math.round(gainM)} m` : '-'}</span>
      </div>
      <div className="save-wrap" ref={saveWrapRef}>
        <button type="button" className="save-btn" title={t('save_title')} disabled={!hasRoute} onClick={openSave}>
          {t('save')}
        </button>
        {saveOpen && (
          <div className="save-pop">
            <input
              type="text"
              ref={el => el?.focus()}
              value={saveName}
              placeholder={t('route_name_placeholder')}
              onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') confirmSave();
                if (e.key === 'Escape') setSaveOpen(false);
              }}
            />
            <button type="button" className="primary" onClick={confirmSave}>
              {t('ok')}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
