import { useRef, useState } from 'react';
import { buildKml, buildTcx, downloadTextFile, type ExportPoint } from '../lib/exportFormats';
import { downloadGpx, type GpxWaypoint, parseGpx } from '../lib/gpx';
import { type MsgKey, tNow, useT } from '../lib/i18n';
import type { Lang } from '../lib/lang';
import { kindDef, kindLabelKey } from '../lib/points';
import { buildShareUrl } from '../lib/share';
import { useClickOutside } from '../lib/useClickOutside';
import { routeCoords, routePois, usePlanner } from '../store';
import { RoutesPanel } from './RoutesPanel';
import { SearchBox } from './SearchBox';

type ExportFormat = 'gpx' | 'kml' | 'tcx';

function closeRoutesPanel() {
  usePlanner.setState({ showRoutes: false });
}

export function TopBar() {
  const t = useT();
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
  const [showExport, setShowExport] = useState(false);
  useClickOutside(routesWrapRef, closeRoutesPanel, showRoutes);
  useClickOutside(exportWrapRef, () => setShowExport(false), showExport);

  const coords = routeCoords(legs);
  const hasRoute = coords.length >= 2;
  const [copied, setCopied] = useState(false);

  async function shareRoute() {
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
      // les repères hors tracé n'ont pas de place sur un parcours horodaté
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
      <span className="brand">⛰️ cairn</span>
      <SearchBox />

      <div className="topbar-group topbar-right">
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
        <button type="button" disabled={!hasRoute} onClick={shareRoute}>
          {copied ? t('copied') : t('share')}
        </button>
        <div className="routes-wrap" ref={exportWrapRef}>
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
