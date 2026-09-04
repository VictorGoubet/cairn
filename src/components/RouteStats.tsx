import { useCallback, useMemo, useRef, useState } from 'react';
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
  const [justSaved, setJustSaved] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [collection, setCollection] = useState('');
  const [typingProject, setTypingProject] = useState(false);
  const savedRoutes = usePlanner(s => s.savedRoutes);
  const collections = useMemo(
    () => [...new Set(savedRoutes.map(r => r.collection).filter((c): c is string => !!c))],
    [savedRoutes],
  );
  // stable identity: an inline ref callback re-runs on every render and steals the focus back
  const focusOnMount = useCallback((el: HTMLInputElement | null) => el?.focus(), []);
  const saveWrapRef = useRef<HTMLDivElement>(null);
  useClickOutside(saveWrapRef, () => setSaveOpen(false), saveOpen);
  useEscapeKey(() => setSaveOpen(false), saveOpen);

  const coords = useMemo(() => routeCoords(legs), [legs]);
  const gainM = useMemo(() => (coords.length ? elevationStats(coords).gainM : 0), [coords]);
  const hasRoute = coords.length >= 2;

  function openSave() {
    const state = usePlanner.getState();
    setSaveName(currentRouteName || `${t('route_of')} ${new Date().toLocaleDateString(dateLocale(lang))}`);
    setCollection(state.savedRoutes.find(r => r.id === state.currentRouteId)?.collection ?? '');
    setTypingProject(false);
    setSaveOpen(true);
  }

  function confirmSave() {
    const name = saveName.trim();
    if (!name) return;
    track('save-route', { distanceKm: Math.round(routeDistanceM(legs) / 1000) });
    // the celebration only follows a real save: a full storage shows its error, not a checkmark
    if (usePlanner.getState().saveCurrentRoute(name, collection)) {
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 2200);
    }
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
        <button
          type="button"
          className={justSaved ? 'save-btn saved' : 'save-btn'}
          title={t('save_title')}
          disabled={!hasRoute}
          onClick={openSave}
        >
          {justSaved ? (
            <>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path className="save-check" d="m5 12.5 5 5L19 7" />
              </svg>
              {t('saved')}
            </>
          ) : (
            t('save')
          )}
        </button>
        {saveOpen && (
          <div className="save-pop">
            <input
              type="text"
              className="save-name"
              ref={focusOnMount}
              value={saveName}
              placeholder={t('route_name_placeholder')}
              onChange={e => setSaveName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') confirmSave();
                if (e.key === 'Escape') setSaveOpen(false);
              }}
            />
            {/* a project is typed once and reused often, so the ones that exist are one tap away */}
            {collections.length > 0 && !typingProject && (
              <div className="save-projects">
                {['', ...collections].map(name => (
                  <button
                    key={name || 'none'}
                    type="button"
                    className={collection === name ? 'chip on' : 'chip'}
                    onClick={() => setCollection(name)}
                  >
                    {name || t('collection_none')}
                  </button>
                ))}
                <button
                  type="button"
                  className="chip new"
                  data-control="project-new"
                  title={t('collection_new')}
                  onClick={() => {
                    setCollection('');
                    setTypingProject(true);
                  }}
                >
                  +
                </button>
              </div>
            )}
            {(typingProject || collections.length === 0) && (
              <input
                type="text"
                className="save-collection"
                ref={typingProject ? focusOnMount : undefined}
                value={collection}
                placeholder={t('collection_placeholder')}
                onChange={e => setCollection(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') confirmSave();
                  if (e.key === 'Escape') setSaveOpen(false);
                }}
              />
            )}
            <button type="button" className="primary" onClick={confirmSave}>
              {t('ok')}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
