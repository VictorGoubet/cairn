import { useCallback, useEffect, useState } from 'react';
import { track } from '../lib/analytics';
import { formatDistance } from '../lib/geo';
import { type MsgKey, useT } from '../lib/i18n';
import { getMapInstance } from '../lib/mapHandle';
import { fetchHikeTrack, fetchNearbyHikes, NEARBY_HIKES_MIN_ZOOM, type NearbyHike } from '../lib/nearbyHikes';
import { usePlanner } from '../store';

/** the list follows the map, but not faster than the volunteer-run Overpass deserves */
const REFRESH_DEBOUNCE_MS = 700;

type Status = 'idle' | 'loading' | 'zoom' | 'error';

/**
 * Marked hiking routes in view, from OpenStreetMap: pick one and it becomes your itinerary.
 *
 * Args:
 *   onLoaded: called once a route has been loaded, so the panel can step out of the way.
 */
export function NearbyHikes({ onLoaded }: { onLoaded: () => void }) {
  const t = useT();
  const [hikes, setHikes] = useState<NearbyHike[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [loadingId, setLoadingId] = useState<number | null>(null);

  const refresh = useCallback(() => {
    const map = getMapInstance();
    if (!map) return;
    if (map.getZoom() < NEARBY_HIKES_MIN_ZOOM) {
      setStatus('zoom');
      setHikes([]);
      return;
    }
    const b = map.getBounds();
    setStatus('loading');
    fetchNearbyHikes({ west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() })
      .then(found => {
        setHikes(found);
        setStatus('idle');
      })
      .catch(() => setStatus('error'));
  }, []);

  useEffect(() => {
    const map = getMapInstance();
    refresh();
    if (!map) return;
    let timer = 0;
    const onMoveEnd = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, REFRESH_DEBOUNCE_MS);
    };
    map.on('moveend', onMoveEnd);
    return () => {
      window.clearTimeout(timer);
      map.off('moveend', onMoveEnd);
    };
  }, [refresh]);

  async function load(hike: NearbyHike) {
    const map = getMapInstance();
    if (!map) return;
    setLoadingId(hike.id);
    const center = map.getCenter();
    try {
      const coords = await fetchHikeTrack(hike.id, [center.lng, center.lat]);
      track('load-nearby-hike', { network: hike.network || 'none' });
      usePlanner.getState().importRoute(coords, []);
      usePlanner.setState({ currentRouteName: hike.ref ? `${hike.ref} - ${hike.name}` : hike.name });
      usePlanner.getState().focusRoute();
      onLoaded();
    } catch {
      setStatus('error');
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <div className="nearby">
      <p className="mc-hint">{t('nearby_hint')}</p>
      {status === 'zoom' && <p className="nearby-empty">{t('nearby_zoom')}</p>}
      {status === 'error' && (
        <p className="nearby-empty">
          {t('nearby_error')}{' '}
          <button type="button" className="nearby-retry" onClick={refresh}>
            {t('retry')}
          </button>
        </p>
      )}
      {status === 'loading' && <p className="nearby-empty">{t('computing')}</p>}
      {status === 'idle' && hikes.length === 0 && <p className="nearby-empty">{t('nearby_none')}</p>}
      <ul className="nearby-list">
        {hikes.map(h => (
          <li key={h.id}>
            <button type="button" disabled={loadingId !== null} onClick={() => load(h)}>
              <span className="nearby-name">
                {h.ref && <span className="nearby-ref">{h.ref}</span>}
                {h.name}
              </span>
              <span className="nearby-meta">
                {h.network && t(`net_${h.network}` as MsgKey)}
                {h.network && h.declaredKm ? ' · ' : ''}
                {h.declaredKm ? formatDistance(h.declaredKm * 1000) : ''}
                {loadingId === h.id ? ` · ${t('computing')}` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
