import { useRef, useState } from 'react';
import { track } from '../lib/analytics';
import { sampleElevations } from '../lib/demElevation';
import { buildKml, buildTcx, downloadTextFile, type ExportPoint } from '../lib/exportFormats';
import type { LonLat } from '../lib/geo';
import { downloadGpx, type GpxWaypoint, mergeTracks, parseGpx } from '../lib/gpx';
import { type MsgKey, tNow, useT } from '../lib/i18n';
import type { Lang } from '../lib/lang';
import { kindDef, kindLabelKey } from '../lib/points';
import { buildPreviewableShareUrl } from '../lib/share';
import { computeStages } from '../lib/stages';
import { useClickOutside } from '../lib/useClickOutside';
import { useEscapeKey } from '../lib/useEscapeKey';
import { useIsMobile } from '../lib/useMediaQuery';
import { routeCoords, routeDistanceM, routePois, usePlanner } from '../store';
import { QrPanel } from './QrPanel';
import { RoutesPanel } from './RoutesPanel';
import { SearchBox } from './SearchBox';
import { SharePanel } from './SharePanel';

type ExportFormat = 'gpx' | 'kml' | 'tcx';

function closeRoutesPanel() {
  usePlanner.setState({ showRoutes: false });
}

export function TopBar() {
  const t = useT();
  const isMobile = useIsMobile();
  const [menuOpen, setMenuOpen] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  const menuToggleRef = useRef<HTMLButtonElement>(null);
  useClickOutside([actionsRef, menuToggleRef], () => setMenuOpen(false), isMobile && menuOpen);
  useEscapeKey(() => setMenuOpen(false), isMobile && menuOpen);
  const lang = usePlanner(s => s.lang);
  const anchors = usePlanner(s => s.anchors);
  const legs = usePlanner(s => s.legs);
  const offRoutePoints = usePlanner(s => s.offRoutePoints);
  const savedRoutes = usePlanner(s => s.savedRoutes);
  const currentRouteName = usePlanner(s => s.currentRouteName);
  const showRoutes = usePlanner(s => s.showRoutes);
  const fileRef = useRef<HTMLInputElement>(null);
  const routesWrapRef = useRef<HTMLDivElement>(null);
  const exportWrapRef = useRef<HTMLDivElement>(null);
  const shareWrapRef = useRef<HTMLDivElement>(null);
  const [showExport, setShowExport] = useState(false);
  const [showShareMenu, setShowShareMenu] = useState(false);
  const [showShareImage, setShowShareImage] = useState(false);
  const [showQr, setShowQr] = useState(false);
  useClickOutside(routesWrapRef, closeRoutesPanel, showRoutes);
  useClickOutside(exportWrapRef, () => setShowExport(false), showExport);
  useClickOutside(shareWrapRef, () => setShowShareMenu(false), showShareMenu);
  useEscapeKey(closeRoutesPanel, showRoutes);
  useEscapeKey(() => setShowExport(false), showExport);
  useEscapeKey(() => setShowShareMenu(false), showShareMenu);

  const coords = routeCoords(legs);
  const hasRoute = coords.length >= 2;
  const [copied, setCopied] = useState(false);
  const [linking, setLinking] = useState(false);

  async function shareRoute() {
    setShowShareMenu(false);
    track('share-link');
    setLinking(true);
    const url = await buildPreviewableShareUrl().finally(() => setLinking(false));
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function exportRoute(format: ExportFormat) {
    setShowExport(false);
    track('export', { format, distanceKm: Math.round(routeDistanceM(legs) / 1000) });
    const named = (point: ExportPoint) => ({ ...point, name: point.name || tNow(kindLabelKey(point.kind)) });
    const pois = routePois(anchors).map(named);
    const allPoints = [...pois, ...offRoutePoints.map(named)];
    const name = currentRouteName || `cairn-${new Date().toISOString().slice(0, 10)}`;
    if (format === 'gpx') {
      const wpts: GpxWaypoint[] = allPoints.map(p => ({ ...p, sym: kindDef(p.kind).garminSym ?? undefined }));
      // a trek cut into days exports one named track per stage, which watches read natively
      downloadGpx(name, coords, wpts, computeStages(anchors, legs, usePlanner.getState().profile));
    } else if (format === 'kml') {
      downloadTextFile(`${name}.kml`, 'application/vnd.google-earth.kml+xml', buildKml(name, coords, allPoints));
    } else {
      // off-route markers have no place in a timestamped route
      downloadTextFile(`${name}.tcx`, 'application/vnd.garmin.tcx+xml', buildTcx(name, coords, pois));
    }
  }

  async function importGpx(files: File[]) {
    const parsed = await Promise.all(
      files.map(file =>
        file
          .text()
          .then(parseGpx)
          .catch(() => null),
      ),
    );
    const usable = parsed.filter(p => p !== null);
    if (usable.length === 0) {
      usePlanner.setState({ error: 'err_gpx' });
      return;
    }
    // several files, and several tracks inside a file, become one itinerary: everything is
    // chained and every waypoint follows, which is also how a waypoints-only export
    // (a list of geocaches) lands as markers to route by
    track('import-gpx', { files: usable.length });
    let coords = mergeTracks(usable.flatMap(p => p.tracks));
    // a planned route (c:geo hands out a <rte> of cache coordinates) carries no elevation, and a
    // profile flat at sea level would poison the climb, the duration and the energy
    if (coords.length >= 2 && !usable.some(p => p.hasElevation)) {
      const elevations = await sampleElevations(coords.map(([lon, lat]) => [lon, lat] as LonLat));
      coords = coords.map(([lon, lat], i) => [lon, lat, elevations[i] ?? 0]);
    }
    usePlanner.getState().importRoute(
      coords,
      usable.flatMap(p => p.waypoints),
    );
    const name = usable.find(p => p.name)?.name;
    if (name) usePlanner.setState({ currentRouteName: name });
  }

  return (
    <header className="topbar">
      <a className="brand" href={import.meta.env.BASE_URL}>
        <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" className="brand-logo" />
        <span className="brand-name">cairn</span>
      </a>
      <a
        className="repo-link"
        href="https://github.com/VictorGoubet/cairn"
        target="_blank"
        rel="noreferrer"
        title={t('source_code')}
        aria-label={t('source_code')}
      >
        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 0a8 8 0 0 0-2.5 15.6c.4.1.5-.2.5-.4v-1.4c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5 0-.5 0-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.4.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.2 0-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.5 7.5 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.5 1.1.2 1.9.1 2.1.5.6.8 1.3.8 2.2 0 3.1-1.9 3.8-3.7 4 .3.3.6.8.6 1.6v2.4c0 .2.1.5.6.4A8 8 0 0 0 8 0z" />
        </svg>
        <span className="visually-hidden">{t('source_code')}</span>
      </a>
      <SearchBox />

      {isMobile && (
        <button
          type="button"
          ref={menuToggleRef}
          className={menuOpen ? 'menu-toggle on' : 'menu-toggle'}
          aria-label={t('actions')}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(v => !v)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        </button>
      )}

      <div
        className={
          isMobile ? `topbar-group topbar-right topbar-sheet${menuOpen ? ' open' : ''}` : 'topbar-group topbar-right'
        }
        ref={actionsRef}
      >
        <div className="segmented lang-seg" title="Langue / Language">
          {(['fr', 'en'] as Lang[]).map(l => (
            <button
              key={l}
              type="button"
              className={lang === l ? 'on' : ''}
              onClick={() => usePlanner.getState().setLang(l)}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="routes-wrap" ref={routesWrapRef}>
          <button type="button" onClick={() => usePlanner.getState().toggleRoutesPanel()}>
            {t('my_routes')}
            {savedRoutes.length > 0 ? ` (${savedRoutes.length})` : ''}
          </button>
          <RoutesPanel />
        </div>
        <button type="button" title={t('import_hint')} onClick={() => fileRef.current?.click()}>
          {t('import')}
        </button>
        <div className="menu-wrap" ref={shareWrapRef}>
          <button type="button" disabled={!hasRoute || linking} onClick={() => setShowShareMenu(v => !v)}>
            {copied ? t('copied') : linking ? t('sharing') : t('share')}
          </button>
          {showShareMenu && (
            <div className="export-menu share-menu">
              <button type="button" onClick={shareRoute}>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M10 14a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.1" />
                  <path d="M14 10a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.1" />
                </svg>
                {t('share_link')}
              </button>
              <button
                type="button"
                data-control="share-image"
                onClick={() => {
                  setShowShareMenu(false);
                  setShowShareImage(true);
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="4" width="18" height="16" rx="3" />
                  <circle cx="9" cy="10" r="1.6" fill="currentColor" stroke="none" />
                  <path d="m4 18 5-5 3.5 3.5L16 13l4 5" />
                </svg>
                {t('share_image')}
              </button>
              <button
                type="button"
                data-control="share-qr"
                onClick={() => {
                  setShowShareMenu(false);
                  setShowQr(true);
                }}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <rect x="4" y="4" width="6" height="6" rx="1" />
                  <rect x="14" y="4" width="6" height="6" rx="1" />
                  <rect x="4" y="14" width="6" height="6" rx="1" />
                  <path d="M14 14h3v3h-3zM20 14v1M20 19v1h-4" />
                </svg>
                {t('share_qr')}
              </button>
            </div>
          )}
        </div>
        <div className="menu-wrap" ref={exportWrapRef}>
          <button type="button" className="primary" disabled={!hasRoute} onClick={() => setShowExport(v => !v)}>
            {t('export')} ▾
          </button>
          {showExport && (
            <div className="export-menu">
              {(['gpx', 'kml', 'tcx'] as ExportFormat[]).map(format => (
                <button key={format} type="button" onClick={() => exportRoute(format)}>
                  <strong>{format.toUpperCase()}</strong>
                  <span>{t(`fmt_${format}` as MsgKey)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {showShareImage && <SharePanel onClose={() => setShowShareImage(false)} />}
      {showQr && <QrPanel onClose={() => setShowQr(false)} />}

      <input
        ref={fileRef}
        type="file"
        accept=".gpx"
        multiple
        hidden
        onChange={e => {
          const files = [...(e.target.files ?? [])];
          if (files.length > 0) void importGpx(files);
          e.target.value = '';
        }}
      />
    </header>
  );
}
