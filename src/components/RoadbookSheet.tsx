import { useState } from 'react';
import { createPortal } from 'react-dom';
import { cumulativeDistancesM, formatDistance, formatDuration, type LonLatEle } from '../lib/geo';
import { useT } from '../lib/i18n';
import { dateLocale } from '../lib/lang';
import { kindDef, kindLabelKey } from '../lib/points';
import { buildRoadbook, type RoadbookRow } from '../lib/roadbook';
import { useEscapeKey } from '../lib/useEscapeKey';
import { routeCoords, usePlanner } from '../store';

/** what a departure defaults to when the sheet opens: early, like a real one */
const DEFAULT_DEPARTURE = '07:00';
/** the sparkline's own coordinate space, stretched to whatever width the paper gives it */
const SPARK_W = 1000;
const SPARK_H = 150;
/** enough points to keep every col and dip, few enough to stay a light path */
const SPARK_SAMPLES = 300;

/**
 * The roadbook, on screen and on paper.
 *
 * Printing is the point, so the page is the deliverable rather than the overlay: the print
 * stylesheet hides the application and keeps this sheet alone, which is also how it becomes a PDF
 * (every browser prints to one). Hence the portal: rendered inside the topbar it would be a
 * descendant of the very element print hides. Nothing here is stored: the table is derived on
 * open, and the departure time is a choice made for that print, not a setting.
 */
export function RoadbookSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const lang = usePlanner(s => s.lang);
  const anchors = usePlanner(s => s.anchors);
  const legs = usePlanner(s => s.legs);
  const profile = usePlanner(s => s.profile);
  const routeName = usePlanner(s => s.currentRouteName);
  const startDate = usePlanner(s => s.startDate);
  const [time, setTime] = useState(DEFAULT_DEPARTURE);
  useEscapeKey(onClose, true);

  const departure = departureAt(startDate, time);
  const book = buildRoadbook(anchors, legs, profile, departure);
  const locale = dateLocale(lang);

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close, Escape works too
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape already closes via useEscapeKey
    <div className="share-overlay roadbook-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="roadbook" role="dialog" aria-label={t('roadbook')} data-control="roadbook">
        <div className="roadbook-bar">
          <label>
            {t('roadbook_departure')}
            <input type="time" value={time} onChange={e => setTime(e.target.value)} />
          </label>
          <button type="button" className="primary" data-control="roadbook-print" onClick={() => window.print()}>
            {t('roadbook_print')}
          </button>
          <button type="button" className="editor-close" title={t('close')} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="roadbook-sheet">
          <h1>{routeName || t('roadbook')}</h1>
          <p className="roadbook-summary">
            {formatDistance(book.distanceM)} · +{Math.round(book.gainM)} m · -{Math.round(book.lossM)} m ·{' '}
            {formatDuration(book.hours)} · {t(`mode_${profile.mode}`)}
            {departure && ` · ${departure.toLocaleDateString(locale)}`}
          </p>
          <ProfileSparkline coords={routeCoords(legs)} marks={book.rows} />
          <table className="roadbook-table">
            <thead>
              <tr>
                <th>{t('roadbook_point')}</th>
                <th>{t('roadbook_alt')}</th>
                <th>{t('roadbook_km')}</th>
                <th>{t('roadbook_leg')}</th>
                <th>{t('roadbook_gain')}</th>
                <th>{t('roadbook_time')}</th>
              </tr>
            </thead>
            <tbody>
              {book.rows.map(row => (
                <tr key={row.anchorIndex}>
                  <td>
                    <span className="rb-icon">{roleIcon(row.role) ?? kindDef(row.kind).emoji}</span>
                    {row.name || t(row.role === 'point' ? kindLabelKey(row.kind) : `roadbook_${row.role}`)}
                  </td>
                  <td>{Math.round(row.elevation)} m</td>
                  <td>{formatDistance(row.distanceM)}</td>
                  <td>{row.role === 'start' ? '—' : formatDistance(row.legDistanceM)}</td>
                  <td>+{Math.round(row.gainM)} m</td>
                  <td>
                    {row.at ? row.at.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : ''}
                    <small>{formatDuration(row.hours)}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="roadbook-foot">{t('roadbook_foot')}</p>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * The route's shape above the table, so the roadbook reads like one.
 *
 * A hairline at every row ties the picture to the rows underneath. The path is stretched to the
 * available width rather than measured, which is what makes it print at any paper size; strokes
 * opt out of that scaling so they stay hairlines instead of turning into wedges.
 */
function ProfileSparkline({ coords, marks }: { coords: LonLatEle[]; marks: RoadbookRow[] }) {
  if (coords.length < 2) return null;
  const dists = cumulativeDistancesM(coords);
  const total = dists[dists.length - 1] || 1;
  const elevations = coords.map(c => c[2]);
  const floor = Math.min(...elevations);
  const span = Math.max(1, Math.max(...elevations) - floor);
  const x = (d: number) => (d / total) * SPARK_W;
  const y = (e: number) => SPARK_H - 4 - ((e - floor) / span) * (SPARK_H - 8);

  const step = Math.max(1, Math.floor(coords.length / SPARK_SAMPLES));
  const points: string[] = [];
  for (let i = 0; i < coords.length; i += step) points.push(`${x(dists[i]).toFixed(1)},${y(elevations[i]).toFixed(1)}`);
  points.push(`${SPARK_W},${y(elevations[elevations.length - 1]).toFixed(1)}`);
  const line = points.join(' ');

  return (
    <svg
      className="roadbook-profile"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${Math.round(floor)} - ${Math.round(floor + span)} m`}
    >
      <polygon points={`0,${SPARK_H} ${line} ${SPARK_W},${SPARK_H}`} />
      {marks.map(row => (
        <line
          key={row.anchorIndex}
          className="rb-mark"
          x1={x(row.distanceM)}
          x2={x(row.distanceM)}
          y1={0}
          y2={SPARK_H}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      <polyline points={line} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** the trek's own start date when it has one, today otherwise: the clock column is what matters */
function departureAt(startDate: string | null, time: string): Date | null {
  const [hours, minutes] = time.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  const day = startDate ? new Date(`${startDate}T00:00:00`) : new Date();
  if (Number.isNaN(day.getTime())) return null;
  day.setHours(hours, minutes, 0, 0);
  return day;
}

function roleIcon(role: 'start' | 'finish' | 'point'): string | null {
  if (role === 'start') return '🟢';
  return role === 'finish' ? '🔴' : null;
}
