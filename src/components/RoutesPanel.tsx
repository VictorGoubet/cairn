import { useEffect, useRef, useState } from 'react';
import { formatDistance } from '../lib/geo';
import { useT } from '../lib/i18n';
import { dateLocale } from '../lib/lang';
import { downloadRouteOffline, markOfflineSaved, offlineSavedAt, releaseOfflineRoute } from '../lib/offline';
import { renderShareImage } from '../lib/shareImage';
import { useEscapeKey } from '../lib/useEscapeKey';
import { byCollection, routeCoords, type SavedRoute, usePlanner } from '../store';
import { OfflineAreas } from './OfflineAreas';

/**
 * Thumbnails already drawn, so a gallery never redraws what it has already shown.
 *
 * Each card renders real map tiles, which is a handful of requests per route: measured at 66 for
 * eight routes on first open and still 44 on the second, since every canvas was redrawn from
 * scratch. Two levels: this map for the session, and the cache storage underneath so a reload does
 * not start from nothing either — which is what was still slow, the memory dying with the page.
 * Jpeg rather than canvases, 30 kB against 420 kB of bitmap apiece.
 *
 * Keyed by `updatedAt` as well as id, so re-saving a route redraws it and the stale entry is swept
 * on the next open.
 */
const thumbCache = new Map<string, string>();
const THUMB_CACHE_MAX = 60;
const THUMB_STORE = 'cairn-thumbs-v1';
/** cache storage needs urls, so the key becomes one; nothing ever fetches it */
const thumbUrl = (key: string) => `/__thumb/${encodeURIComponent(key)}`;

function close() {
  usePlanner.setState({ showRoutes: false });
}

async function paintThumb(target: HTMLCanvasElement, route: SavedRoute): Promise<void> {
  const key = `${route.id}@${route.updatedAt}`;
  const cached = thumbCache.get(key) ?? (await readStoredThumb(key));
  if (cached) {
    thumbCache.set(key, cached);
    return drawDataUrl(target, cached);
  }

  const coords = routeCoords(route.legs);
  if (coords.length < 2) return;
  await renderShareImage(target, coords, {
    format: 'square',
    background: 'plan',
    showStats: false,
    showProfile: false,
    title: '',
    scale: 0.3,
  });
  // a tile server that ever answers without cors headers taints the canvas: then there is nothing
  // to keep, and the card is still drawn
  try {
    const dataUrl = target.toDataURL('image/jpeg', 0.82);
    if (thumbCache.size >= THUMB_CACHE_MAX) thumbCache.delete(thumbCache.keys().next().value as string);
    thumbCache.set(key, dataUrl);
    void storeThumb(key, dataUrl);
  } catch {
    thumbCache.delete(key);
  }
}

async function readStoredThumb(key: string): Promise<string | null> {
  if (!('caches' in globalThis)) return null;
  try {
    const cache = await caches.open(THUMB_STORE);
    const hit = await cache.match(thumbUrl(key));
    return hit ? await hit.text() : null;
  } catch {
    return null;
  }
}

async function storeThumb(key: string, dataUrl: string): Promise<void> {
  if (!('caches' in globalThis)) return;
  try {
    const cache = await caches.open(THUMB_STORE);
    await cache.put(thumbUrl(key), new Response(dataUrl, { headers: { 'content-type': 'text/plain' } }));
  } catch {
    // a full or blocked cache storage costs a redraw, never a broken gallery
  }
}

/** thumbnails of routes that no longer exist, or of versions that have been re-saved */
async function sweepStoredThumbs(routes: SavedRoute[]): Promise<void> {
  if (!('caches' in globalThis)) return;
  try {
    const cache = await caches.open(THUMB_STORE);
    const live = new Set(routes.map(route => thumbUrl(`${route.id}@${route.updatedAt}`)));
    const stored = await cache.keys();
    await Promise.all(stored.map(request => (live.has(new URL(request.url).pathname) ? null : cache.delete(request))));
  } catch {
    // nothing to sweep is not a failure worth reporting
  }
}

async function drawDataUrl(target: HTMLCanvasElement, dataUrl: string): Promise<void> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  target.width = image.width;
  target.height = image.height;
  target.getContext('2d')?.drawImage(image, 0, 0);
}

/** saved routes as a gallery of map cards, drawn by the share-tile renderer */
export function RoutesPanel() {
  const t = useT();
  const showRoutes = usePlanner(s => s.showRoutes);
  const savedRoutes = usePlanner(s => s.savedRoutes);
  const currentRouteId = usePlanner(s => s.currentRouteId);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  useEscapeKey(close, showRoutes);
  const groups = byCollection(savedRoutes).length;

  // one sweep per opening keeps the store in step with the gallery it serves
  useEffect(() => {
    if (showRoutes) void sweepStoredThumbs(savedRoutes);
  }, [showRoutes, savedRoutes]);

  if (!showRoutes) return null;

  // first click arms the confirmation, second click deletes: no native dialog
  function remove(id: string) {
    if (confirmId !== id) {
      setConfirmId(id);
      return;
    }
    // the route goes, and with it the corridor it had downloaded: nothing would point at it
    const route = usePlanner.getState().savedRoutes.find(r => r.id === id);
    if (route) void releaseOfflineRoute(id, routeCoords(route.legs));
    usePlanner.getState().deleteRoute(id);
    setConfirmId(null);
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
          {byCollection(savedRoutes).map(group => (
            <section key={group.name || 'loose'} className="routes-group">
              {/* a named project always says its name; "no project" only when something else has one */}
              {(group.name !== '' || groups > 1) && (
                <h4>
                  {group.name || t('collection_none')}
                  <span>
                    {group.routes.length} · {formatDistance(group.routes.reduce((sum, r) => sum + r.distanceM, 0))} · +
                    {Math.round(group.routes.reduce((sum, r) => sum + r.gainM, 0))} m
                  </span>
                </h4>
              )}
              <ul className="routes-grid">
                {group.routes.map(r => (
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
            </section>
          ))}
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
  const [painted, setPainted] = useState(false);

  // a card out of sight costs tiles for nothing: twenty saved routes would fetch for all twenty.
  // the frame that decides what is visible is the modal itself, the only bounded scroller here
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setPainted(false);
    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect();
        void paintThumb(canvas, route).then(() => setPainted(true));
      },
      { root: canvas.closest('.share-panel'), rootMargin: '150px' },
    );
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [route]);

  return (
    <>
      <button
        type="button"
        className="route-load"
        title={t('load')}
        onClick={() => usePlanner.getState().loadRoute(route.id)}
      >
        <canvas ref={canvasRef} className={painted ? 'route-thumb' : 'route-thumb loading'} />
        <span className="route-name">{route.name}</span>
        <span className="route-meta">
          {formatDistance(route.distanceM)} · {Math.round(route.gainM)} m D+ ·{' '}
          {new Date(route.updatedAt).toLocaleDateString(dateLocale(lang))}
        </span>
      </button>
      <div className="route-actions">
        <OfflineButton route={route} />
        <button
          type="button"
          className={confirming ? 'route-action route-remove armed' : 'route-action route-remove'}
          title={t('delete')}
          aria-label={t('delete')}
          onBlur={onDisarm}
          onClick={onRemove}
        >
          {confirming ? (
            // a red check, not the word: a text pill gets clipped inside an icon bar
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
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
              aria-hidden="true"
            >
              <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
            </svg>
          )}
        </button>
      </div>
    </>
  );
}

/** downloads the route's corridor into the cache, and says so once it is there */
/** downloads the route's bundle, and takes it back off the device on the next tap */
function OfflineButton({ route }: { route: SavedRoute }) {
  const t = useT();
  const [percent, setPercent] = useState<number | null>(null);
  const [saved, setSaved] = useState(() => offlineSavedAt(route.id) !== null);

  async function toggle() {
    if (percent !== null) return;
    if (saved) {
      // freeing is cheap to undo (one tap re-downloads), so it needs no confirmation
      await releaseOfflineRoute(route.id, routeCoords(route.legs));
      setSaved(false);
      return;
    }
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

  const label = saved ? t('offline_remove_hint') : t('offline_download_hint');
  return (
    <button
      type="button"
      className={saved ? 'route-action route-offline saved' : 'route-action route-offline'}
      data-control="route-offline"
      title={label}
      aria-label={label}
      disabled={percent !== null}
      onClick={toggle}
    >
      {percent !== null ? (
        <span className="route-percent">{percent}%</span>
      ) : saved ? (
        <>
          {/* stored: a check at rest, and what the tap would do on hover */}
          <svg
            className="on-rest"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m5 12 5 5L19 8" />
          </svg>
          <svg
            className="on-hover"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M7 12h10" />
            <circle cx="12" cy="12" r="9" />
          </svg>
        </>
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
