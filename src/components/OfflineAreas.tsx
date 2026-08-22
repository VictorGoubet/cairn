import { useEffect, useState } from 'react';
import { useT } from '../lib/i18n';
import { dateLocale } from '../lib/lang';
import { getMapInstance } from '../lib/mapHandle';
import {
  type AreaBounds,
  areaThumbUrl,
  areaUrls,
  bundleMegabytes,
  deleteOfflineArea,
  downloadAreaOffline,
  estimateArea,
  listOfflineAreas,
  type OfflineArea,
  offlineStorageReport,
} from '../lib/offline';
import { usePlanner } from '../store';

/**
 * Offline areas: the days you head out without an itinerary.
 *
 * The area is whatever the map framed when this panel opened, named by the hiker (a reverse
 * geocode would call the bois de Vincennes "Paris 12e"), with its weight announced before the
 * tap. The total underneath counts the zones shared between bundles once, which is what the
 * disk actually holds.
 */
export function OfflineAreas() {
  const t = useT();
  const lang = usePlanner(s => s.lang);
  const [areas, setAreas] = useState<OfflineArea[]>(() => listOfflineAreas());
  const [bounds, setBounds] = useState<AreaBounds | null>(null);
  const [name, setName] = useState('');
  const [naming, setNaming] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);

  // the framing is read once, when the panel opens over the map the hiker had set up
  useEffect(() => {
    const map = getMapInstance();
    if (!map) return;
    const b = map.getBounds();
    setBounds({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() });
  }, []);

  const estimate = bounds ? estimateArea(bounds, usePlanner.getState().baseLayerId) : null;
  const report = offlineStorageReport();

  async function download() {
    const label = name.trim();
    if (!bounds || !estimate || estimate.tooLarge || !label || percent !== null) return;
    setPercent(0);
    try {
      const area = await downloadAreaOffline(
        bounds,
        label,
        ({ done, total }) => setPercent(Math.round((done / total) * 100)),
        usePlanner.getState().baseLayerId,
      );
      setAreas([area, ...areas]);
      usePlanner.getState().bumpOfflineVersion();
      setNaming(false);
      setName('');
    } catch {
      usePlanner.setState({ error: 'err_offline' });
    } finally {
      setPercent(null);
    }
  }

  async function remove(id: string) {
    await deleteOfflineArea(id);
    setAreas(listOfflineAreas());
    usePlanner.getState().bumpOfflineVersion();
  }

  return (
    <section className="offline-areas">
      <h4>{t('offline_areas')}</h4>
      {naming ? (
        <div className="area-name-row">
          <input
            type="text"
            ref={el => el?.focus()}
            value={name}
            placeholder={t('offline_area_name_placeholder')}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void download();
              if (e.key === 'Escape') setNaming(false);
            }}
          />
          <button
            type="button"
            className="primary"
            data-control="area-confirm"
            disabled={!name.trim() || percent !== null}
            onClick={download}
          >
            {percent !== null ? `${percent}%` : t('ok')}
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="area-download"
          data-control="area-download"
          disabled={!estimate || estimate.tooLarge}
          onClick={() => setNaming(true)}
        >
          {estimate?.tooLarge
            ? t('offline_area_too_large')
            : `${t('offline_area_download')}${estimate ? ` · ~${estimate.megabytes} Mo` : ''}`}
        </button>
      )}
      {areas.length > 0 && (
        <ul className="area-list">
          {areas.map(area => (
            <li key={area.id}>
              <img className="area-thumb" src={areaThumbUrl(area.bounds)} alt="" loading="lazy" />
              <span className="area-name">{area.name}</span>
              <span className="area-meta">
                {/* recomputed, never the count stored at download time: a stored number goes
                    stale the day the bundle's layers or zooms change, and then the per-area
                    sizes contradict the total underneath */}
                ~{bundleMegabytes(areaUrls(area.bounds).length)} Mo ·{' '}
                {new Date(area.savedAt).toLocaleDateString(dateLocale(lang))}
              </span>
              <button type="button" className="wp-remove" title={t('delete')} onClick={() => remove(area.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {report.bundles > 0 && (
        <p className="side-hint" data-control="offline-total">
          {t('offline_total')} {report.bundles} · ~{report.megabytes} Mo
        </p>
      )}
    </section>
  );
}
