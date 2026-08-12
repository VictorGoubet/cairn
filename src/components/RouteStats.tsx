import { useMemo, useRef, useState } from 'react';
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
 *
 * Args:
 *   compact: drops the focus button, the sheet header has little room.
 */
export function RouteStats({ compact = false }: { compact?: boolean }) {
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
      {!compact && (
        <button
          type="button"
          className="focus-btn"
          title={t('focus_route')}
          disabled={!hasRoute}
          onClick={() => usePlanner.getState().focusRoute()}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
            <path d="M7 14.5c2.5-6 5 4 10-5" />
          </svg>
        </button>
      )}
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
