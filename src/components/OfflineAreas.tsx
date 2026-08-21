import { useEffect, useState } from 'react';
import { describePlace } from '../lib/geocode';
import { tNow, useT } from '../lib/i18n';
import { dateLocale } from '../lib/lang';
import { getMapInstance } from '../lib/mapHandle';
import {
  type AreaBounds,
  bundleMegabytes,
  deleteOfflineArea,
  downloadAreaOffline,
  estimateArea,
  listOfflineAreas,
  type OfflineArea,
} from '../lib/offline';
import { usePlanner } from '../store';

/**
 * Offline areas: the days you head out without an itinerary.
 *
 * The area is whatever the map framed when this panel opened, named after the place it covers,
 * with its weight announced before the tap: a download that surprises the disk is a bad one.
 */
export function OfflineAreas() {
  const t = useT();
  const lang = usePlanner(s => s.lang);
  const [areas, setAreas] = useState<OfflineArea[]>(() => listOfflineAreas());
  const [frame, setFrame] = useState<{ bounds: AreaBounds; name: string } | null>(null);
  const [percent, setPercent] = useState<number | null>(null);

  // the framing is read once, when the panel opens over the map the hiker had set up
  useEffect(() => {
    const map = getMapInstance();
    if (!map) return;
    const b = map.getBounds();
    const bounds = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
    const center = map.getCenter();
    let stale = false;
    setFrame({ bounds, name: tNow('offline_area_here') });
    void describePlace(center.lng, center.lat).then(place => {
      if (!stale && place) setFrame({ bounds, name: place });
    });
    return () => {
      stale = true;
    };
    // no dependency on `t`: useT returns a fresh closure per render, and this effect writes
    // state, so listing it would loop the reverse geocoder forever
  }, []);

  const estimate = frame ? estimateArea(frame.bounds, usePlanner.getState().baseLayerId) : null;

  async function download() {
    if (!frame || !estimate || estimate.tooLarge || percent !== null) return;
    setPercent(0);
    try {
      const area = await downloadAreaOffline(
        frame.bounds,
        frame.name,
        ({ done, total }) => setPercent(Math.round((done / total) * 100)),
        usePlanner.getState().baseLayerId,
      );
      setAreas([area, ...areas]);
    } catch {
      usePlanner.setState({ error: 'err_offline' });
    } finally {
      setPercent(null);
    }
  }

  async function remove(id: string) {
    await deleteOfflineArea(id);
    setAreas(listOfflineAreas());
  }

  return (
    <section className="offline-areas">
      <h4>{t('offline_areas')}</h4>
      <button
        type="button"
        className="area-download"
        data-control="area-download"
        disabled={!estimate || estimate.tooLarge || percent !== null}
        onClick={download}
      >
        {percent !== null
          ? `${t('offline_area_downloading')} ${percent}%`
          : estimate?.tooLarge
            ? t('offline_area_too_large')
            : `${t('offline_area_download')}${frame ? ` · ${frame.name}` : ''}${
                estimate ? ` · ~${estimate.megabytes} Mo` : ''
              }`}
      </button>
      {areas.length > 0 && (
        <ul className="area-list">
          {areas.map(area => (
            <li key={area.id}>
              <span className="area-name">{area.name}</span>
              <span className="area-meta">
                ~{bundleMegabytes(area.resources)} Mo · {new Date(area.savedAt).toLocaleDateString(dateLocale(lang))}
              </span>
              <button type="button" className="wp-remove" title={t('delete')} onClick={() => remove(area.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
