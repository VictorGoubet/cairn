import { useRef, useState } from 'react';
import { buildKml, buildTcx, downloadTextFile, type ExportPoint } from '../lib/exportFormats';
import { downloadGpx, type GpxWaypoint, parseGpx } from '../lib/gpx';
import { type MsgKey, tNow, useT } from '../lib/i18n';
import type { Lang } from '../lib/lang';
import { kindDef, kindLabelKey } from '../lib/points';
import { buildShareUrl } from '../lib/share';
import { useClickOutside } from '../lib/useClickOutside';
import { useEscapeKey } from '../lib/useEscapeKey';
import { useIsMobile } from '../lib/useMediaQuery';
import { routeCoords, routePois, usePlanner } from '../store';
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
  useClickOutside(actionsRef, () => setMenuOpen(false), isMobile && menuOpen);
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
  useClickOutside(routesWrapRef, closeRoutesPanel, showRoutes);
  useClickOutside(exportWrapRef, () => setShowExport(false), showExport);
  useClickOutside(shareWrapRef, () => setShowShareMenu(false), showShareMenu);
  useEscapeKey(closeRoutesPanel, showRoutes);
  useEscapeKey(() => setShowExport(false), showExport);
  useEscapeKey(() => setShowShareMenu(false), showShareMenu);

  const coords = routeCoords(legs);
  const hasRoute = coords.length >= 2;
  const [copied, setCopied] = useState(false);

  async function shareRoute() {
    setShowShareMenu(false);
    await navigator.clipboard.writeText(await buildShareUrl());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function exportRoute(format: ExportFormat) {
    setShowExport(false);
    const named = (point: ExportPoint) => ({ ...point, name: point.name || tNow(kindLabelKey(point.kind)) });
    const pois = routePois(anchors).map(named);
    const allPoints = [...pois, ...offRoutePoints.map(named)];
    const name = currentRouteName || `cairn-${new Date().toISOString().slice(0, 10)}`;
    if (format === 'gpx') {
      const wpts: GpxWaypoint[] = allPoints.map(p => ({ ...p, sym: kindDef(p.kind).garminSym ?? undefined }));
      downloadGpx(name, coords, wpts);
    } else if (format === 'kml') {
      downloadTextFile(`${name}.kml`, 'application/vnd.google-earth.kml+xml', buildKml(name, coords, allPoints));
    } else {
      // off-route markers have no place in a timestamped route
      downloadTextFile(`${name}.tcx`, 'application/vnd.garmin.tcx+xml', buildTcx(name, coords, pois));
    }
  }

  async function importGpx(file: File) {
    try {
      const { coords: imported, waypoints: importedWpts } = parseGpx(await file.text());
      usePlanner.getState().importRoute(imported, importedWpts);
    } catch {
      usePlanner.setState({ error: 'err_gpx' });
    }
  }

  return (
    <header className="topbar">
      <a className="brand" href={import.meta.env.BASE_URL}>
        <span aria-hidden="true">⛰️</span>
        <span className="brand-name">cairn</span>
      </a>
      <SearchBox />

      {isMobile && (
        <button
          type="button"
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
        <button type="button" onClick={() => fileRef.current?.click()}>
          {t('import')}
        </button>
        <div className="menu-wrap" ref={shareWrapRef}>
          <button type="button" disabled={!hasRoute} onClick={() => setShowShareMenu(v => !v)}>
            {copied ? t('copied') : t('share')}
          </button>
          {showShareMenu && (
            <div className="export-menu">
              <button type="button" onClick={shareRoute}>
                <strong>{t('share_link')}</strong>
                <span>{t('share_link_hint')}</span>
              </button>
              <button
                type="button"
                data-control="share-image"
                onClick={() => {
                  setShowShareMenu(false);
                  setShowShareImage(true);
                }}
              >
                <strong>{t('share_image')}</strong>
                <span>{t('share_image_hint')}</span>
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

      <input
        ref={fileRef}
        type="file"
        accept=".gpx"
        hidden
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) importGpx(file);
          e.target.value = '';
        }}
      />
    </header>
  );
}
