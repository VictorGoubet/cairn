import { useEffect, useRef, useState } from 'react';
import { formatDistance } from '../lib/geo';
import { useT } from '../lib/i18n';
import { dateLocale } from '../lib/lang';
import { downloadRouteOffline, markOfflineSaved, offlineSavedAt } from '../lib/offline';
import { renderShareImage } from '../lib/shareImage';
import { useEscapeKey } from '../lib/useEscapeKey';
import { routeCoords, type SavedRoute, usePlanner } from '../store';
import { OfflineAreas } from './OfflineAreas';

function close() {
  usePlanner.setState({ showRoutes: false });
}

/** saved routes as a gallery of map cards, drawn by the share-tile renderer */
export function RoutesPanel() {
  const t = useT();
  const showRoutes = usePlanner(s => s.showRoutes);
  const savedRoutes = usePlanner(s => s.savedRoutes);
  const currentRouteId = usePlanner(s => s.currentRouteId);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  useEscapeKey(close, showRoutes);

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
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close, Escape works too
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape already closes via useEscapeKey
    <div className="share-overlay" onClick={e => e.target === e.currentTarget && close()}>
      <div className="share-panel routes-modal" role="dialog" aria-label={t('my_routes')}>
        <div className="share-head">
          <h3>{t('my_routes')}</h3>
          <button type="button" className="share-close" aria-label={t('close')} onClick={close}>
            ×
          </button>
        </div>
        <div className="routes-panel">
          {savedRoutes.length === 0 && <p className="routes-empty">{t('no_routes')}</p>}
          <ul className="routes-grid">
            {savedRoutes.map(r => (
              <li key={r.id} className={r.id === currentRouteId ? 'active' : undefined}>
                <RouteCard
                  route={r}
                  confirming={confirmId === r.id}
                  onRemove={() => remove(r.id)}
                  onDisarm={() => setConfirmId(null)}
                />
              </li>
            ))}
          </ul>
          <OfflineAreas />
        </div>
      </div>
    </div>
  );
}

function RouteCard({
  route,
  confirming,
  onRemove,
  onDisarm,
}: {
  route: SavedRoute;
  confirming: boolean;
  onRemove: () => void;
  onDisarm: () => void;
}) {
  const t = useT();
  const lang = usePlanner(s => s.lang);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const coords = routeCoords(route.legs);
    if (coords.length < 2) return;
    void renderShareImage(canvas, coords, {
      format: 'square',
      background: 'plan',
      showStats: false,
      showProfile: false,
      title: '',
      scale: 0.3,
    });
  }, [route]);

  return (
    <>
      <button
        type="button"
        className="route-load"
        title={t('load')}
        onClick={() => usePlanner.getState().loadRoute(route.id)}
      >
        <canvas ref={canvasRef} className="route-thumb" />
        <span className="route-name">{route.name}</span>
        <span className="route-meta">
          {formatDistance(route.distanceM)} · {Math.round(route.gainM)} m D+ ·{' '}
          {new Date(route.updatedAt).toLocaleDateString(dateLocale(lang))}
        </span>
      </button>
      <OfflineButton route={route} />
      <button
        type="button"
        className={confirming ? 'route-remove armed' : 'route-remove'}
        title={t('delete')}
        onBlur={onDisarm}
        onClick={onRemove}
      >
        {confirming ? t('confirm') : '×'}
      </button>
    </>
  );
}

/** downloads the route's corridor into the cache, and says so once it is there */
function OfflineButton({ route }: { route: SavedRoute }) {
  const t = useT();
  const [percent, setPercent] = useState<number | null>(null);
  const [saved, setSaved] = useState(() => offlineSavedAt(route.id) !== null);

  async function download() {
    if (percent !== null) return;
    setPercent(0);
    try {
      await downloadRouteOffline(
        routeCoords(route.legs),
        ({ done, total }) => setPercent(Math.round((done / total) * 100)),
        usePlanner.getState().baseLayerId,
      );
      markOfflineSaved(route.id);
      setSaved(true);
    } catch {
      usePlanner.setState({ error: 'err_offline' });
    } finally {
      setPercent(null);
    }
  }

  return (
    <button
      type="button"
      className={saved ? 'route-offline saved' : 'route-offline'}
      data-control="route-offline"
      title={saved ? t('offline_saved_hint') : t('offline_download_hint')}
      disabled={percent !== null}
      onClick={download}
    >
      {percent !== null ? (
        `${percent}%`
      ) : saved ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="m5 12 5 5L19 8" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5" />
          <path d="M4 19.5h16" />
        </svg>
      )}
    </button>
  );
}
