import { useEffect, useRef, useState } from 'react';
import { track } from '../lib/analytics';
import { formatDistance } from '../lib/geo';
import { downloadGpx } from '../lib/gpx';
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
/** long enough for a tile on a phone connection, short enough that one slow tile costs nothing */
const THUMB_TILE_DEADLINE_MS = 3000;
/** how far outside the frame a card is still worth drawing, so scrolling finds it ready */
const VIEW_MARGIN_PX = 150;

/**
 * The map halves of the cards, drawn one after another.
 *
 * Eight cards decoding eight tiles each at the same time blocks the main thread long enough that
 * the browser paints nothing at all: measured at 1.8 seconds during which the traces were already
 * on their canvases, waiting for a frame. Queued and yielding between cards, the shapes appear at
 * once and the maps arrive behind them.
 */
let mapQueue: Promise<unknown> = Promise.resolve();

function queueMapPass(work: () => Promise<void>): Promise<void> {
  const next = mapQueue.then(() => work()).catch(() => undefined);
  mapQueue = next.then(() => new Promise(resolve => setTimeout(resolve, 0)));
  return next;
}

function close() {
  usePlanner.setState({ showRoutes: false });
}

/**
 * Draws one card, in two passes when nothing is cached.
 *
 * The shape of the route needs no network and no storage at all, so it is drawn first and the card
 * stops pulsing immediately; the map underneath arrives a moment later. Nothing is awaited before
 * that first stroke, and the order matters more than it looks: cache storage is serialised per
 * origin, so while the worker is writing the tiles of a first visit, a single `caches.open` plus
 * `match` was measured at 1.9 seconds. Reading the cache first meant every card waited on the
 * worker's queue to show a shape that needed nothing from it.
 *
 * Args:
 *   target: the visible canvas, whose pulse is lifted as soon as it has ink. That is done on the
 *     node rather than through react state: with the main thread decoding the tiles of eight
 *     cards, the flush of a `setState` was measured 1.8 seconds after the trace was already drawn.
 *   route: the saved route to draw.
 */
async function paintThumb(target: HTMLCanvasElement, route: SavedRoute): Promise<void> {
  const key = `${route.id}@${route.updatedAt}`;
  const coords = routeCoords(route.legs);
  if (coords.length < 2) return;
  const shape = { format: 'square', showStats: false, showProfile: false, title: '', scale: 0.3 } as const;

  const remembered = thumbCache.get(key);
  if (remembered) {
    await drawDataUrl(target, remembered);
    target.classList.remove('loading');
    return;
  }

  // the trace, right away, from nothing but the geometry already in memory
  await renderShareImage(target, coords, { ...shape, background: 'light', instant: true });
  target.classList.remove('loading');

  const stored = await readStoredThumb(key);
  if (stored) {
    thumbCache.set(key, stored);
    await drawDataUrl(target, stored);
    return;
  }
  await queueMapPass(() =>
    renderShareImage(target, coords, { ...shape, background: 'plan', deadlineMs: THUMB_TILE_DEADLINE_MS }),
  );
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

/** opened once and shared: eight cards opening the same store queue behind each other for nothing */
let thumbStore: Promise<Cache> | null = null;

function openThumbStore(): Promise<Cache> | null {
  if (!('caches' in globalThis)) return null;
  thumbStore ??= caches.open(THUMB_STORE);
  return thumbStore;
}

async function readStoredThumb(key: string): Promise<string | null> {
  try {
    const cache = await openThumbStore();
    const hit = await cache?.match(thumbUrl(key));
    return hit ? await hit.text() : null;
  } catch {
    return null;
  }
}

async function storeThumb(key: string, dataUrl: string): Promise<void> {
  try {
    const cache = await openThumbStore();
    await cache?.put(thumbUrl(key), new Response(dataUrl, { headers: { 'content-type': 'text/plain' } }));
  } catch {
    // a full or blocked cache storage costs a redraw, never a broken gallery
  }
}

/** thumbnails of routes that no longer exist, or of versions that have been re-saved */
async function sweepStoredThumbs(routes: SavedRoute[]): Promise<void> {
  try {
    const cache = await openThumbStore();
    if (!cache) return;
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
              {(group.name !== '' || groups > 1) && <GroupHead group={group} named={group.name !== ''} />}
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

/**
 * A project's heading: what it holds, and the two things a project can do as a whole.
 *
 * Renaming carries every course with it, and the export is one gpx with a `<trk>` per course,
 * which is the format every planner and watch already reads: the courses of a race arrive as the
 * courses of a race, not as five files to open one by one.
 */
function GroupHead({ group, named }: { group: { name: string; routes: SavedRoute[] }; named: boolean }) {
  const t = useT();
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(group.name);

  function rename() {
    usePlanner.getState().renameCollection(group.name, draft);
    setRenaming(false);
  }

  // first tap arms, second one deletes, like a single card: no native dialog anywhere in this app
  function removeProject() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    // the courses go and their downloaded corridors with them: nothing would point at them
    for (const route of group.routes) void releaseOfflineRoute(route.id, routeCoords(route.legs));
    usePlanner.getState().deleteRoutes(group.routes.map(route => route.id));
    setConfirming(false);
  }

  function exportProject() {
    const tracks = group.routes
      .map(route => ({ name: route.name, coords: routeCoords(route.legs) }))
      .filter(track => track.coords.length >= 2);
    if (tracks.length === 0) return;
    const name = group.name || t('my_routes');
    track('export-project', { format: 'gpx', courses: tracks.length });
    downloadGpx(name, tracks[0].coords, [], tracks);
  }

  if (renaming) {
    return (
      <h4 className="group-renaming">
        <input
          type="text"
          ref={el => {
            el?.focus();
          }}
          value={draft}
          placeholder={t('collection_placeholder')}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') rename();
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
        <button type="button" className="primary" data-control="project-rename-ok" onClick={rename}>
          {t('ok')}
        </button>
      </h4>
    );
  }

  return (
    <h4>
      {group.name || t('collection_none')}
      <span>
        {group.routes.length} · {formatDistance(group.routes.reduce((sum, r) => sum + r.distanceM, 0))} · +
        {Math.round(group.routes.reduce((sum, r) => sum + r.gainM, 0))} m
      </span>
      <span className="group-actions">
        {named && (
          <button
            type="button"
            data-control="project-rename"
            title={t('collection_rename')}
            onClick={() => {
              setDraft(group.name);
              setRenaming(true);
            }}
            aria-label={t('collection_rename')}
          >
            <PencilIcon />
          </button>
        )}
        <button type="button" data-control="project-export" title={t('collection_export')} onClick={exportProject}>
          GPX
        </button>
        <button
          type="button"
          className={confirming ? 'group-remove armed' : 'group-remove'}
          data-control="project-remove"
          title={`${t('collection_delete')} (${group.routes.length})`}
          aria-label={`${t('collection_delete')} (${group.routes.length})`}
          onBlur={() => setConfirming(false)}
          onClick={removeProject}
        >
          {confirming ? <CheckIcon /> : <TrashIcon />}
        </button>
      </span>
    </h4>
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

  // a card out of sight costs tiles for nothing: twenty saved routes would fetch for all twenty.
  // what is already on screen is drawn at once, though, without waiting for the browser to deliver
  // an intersection: measured at 1.9 s of delivery delay while the main thread decodes tiles
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.classList.add('loading');
    const scroller = canvas.closest('.share-panel');
    if (inFrame(canvas, scroller)) {
      void paintThumb(canvas, route);
      return;
    }
    const observer = new IntersectionObserver(
      entries => {
        if (!entries.some(entry => entry.isIntersecting)) return;
        observer.disconnect();
        void paintThumb(canvas, route);
      },
      { root: scroller, rootMargin: `${VIEW_MARGIN_PX}px` },
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
        <canvas ref={canvasRef} className="route-thumb loading" />
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
          {/* a red check, not the word: a text pill gets clipped inside an icon bar */}
          {confirming ? <CheckIcon /> : <TrashIcon />}
        </button>
      </div>
    </>
  );
}

/** already on screen, or close enough that a small scroll would bring it in */
function inFrame(el: HTMLElement, scroller: Element | null): boolean {
  const box = el.getBoundingClientRect();
  const frame = scroller?.getBoundingClientRect();
  const top = frame ? frame.top : 0;
  const bottom = frame ? frame.bottom : window.innerHeight;
  return box.bottom > top - VIEW_MARGIN_PX && box.top < bottom + VIEW_MARGIN_PX;
}

/** the panel's two glyphs, drawn rather than typed: an emoji would not follow the button's colour */
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 20h4L20 8l-4-4L4 16v4M14 6l4 4" />
    </svg>
  );
}

function CheckIcon() {
  return (
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
  );
}

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
