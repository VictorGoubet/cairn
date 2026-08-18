import { useEffect, useState } from 'react';
import { track } from '../lib/analytics';
import { type FollowFix, OFF_ROUTE_M, startFollow } from '../lib/follow';
import { formatDistance, formatDuration } from '../lib/geo';
import { useT } from '../lib/i18n';
import { getMapInstance } from '../lib/mapHandle';
import { routeCoords, usePlanner } from '../store';

/** zoom the map settles on when following: close enough to read the trail junctions */
const FOLLOW_ZOOM = 15.5;

/**
 * Live position along the route: am I on the trail, what is next, how much is left.
 *
 * The bar owns the geolocation watch, so the live fix never touches the store: a position
 * arrives every second or so, and the draft writer subscribes to every store write.
 */
export function FollowBar() {
  const t = useT();
  const following = usePlanner(s => s.following);
  const legs = usePlanner(s => s.legs);
  const anchors = usePlanner(s => s.anchors);
  const [fix, setFix] = useState<FollowFix | null>(null);
  const [denied, setDenied] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the route is read once per session
  useEffect(() => {
    if (!following) {
      setFix(null);
      setDenied(false);
      return;
    }
    const coords = routeCoords(legs);
    if (coords.length < 2) return;
    track('follow');
    // named points only: "next point" has to mean something on screen
    let cum = 0;
    const pois = anchors.flatMap((anchor, i) => {
      if (i > 0) cum += legs[i - 1]?.leg?.distanceM ?? 0;
      const named = anchor.name || (anchor.kind !== 'checkpoint' ? t(`kind_${anchor.kind}`) : '');
      return named ? [{ name: named, distM: cum }] : [];
    });
    const handle = startFollow(
      coords,
      pois,
      usePlanner.getState().profile,
      (next: FollowFix) => {
        setFix(next);
        // a hiccup in the signal must not condemn the display: a fresh fix clears the error
        setDenied(false);
        const map = getMapInstance();
        // the map stays under the walker; panning by hand is for when following is off
        map?.easeTo({ center: next.position, zoom: Math.max(map.getZoom(), FOLLOW_ZOOM), duration: 700 });
      },
      () => setDenied(true),
    );
    return () => handle.stop();
  }, [following]);

  if (!following) return null;

  // a phone in a valley reports tens of metres of error: the warning waits until even that
  // cannot explain the gap, so it means something when it shows
  const offRoute = fix !== null && fix.offRouteM > OFF_ROUTE_M + fix.accuracyM;
  return (
    <div className={offRoute ? 'follow-bar off-route' : 'follow-bar'} data-control="follow-bar">
      {fix === null ? (
        <span className="follow-message">{denied ? t('follow_denied') : t('follow_waiting')}</span>
      ) : (
        <>
          <div className="follow-item follow-next">
            <span className="follow-label">{t('follow_next')}</span>
            <span className="follow-value">
              {fix.next
                ? `${fix.next.name} · ${formatDistance(fix.next.distanceM)}${
                    fix.next.gainM >= 20 ? ` · +${Math.round(fix.next.gainM)} m` : ''
                  }`
                : t('follow_finish')}
            </span>
          </div>
          <div className="follow-item">
            <span className="follow-label">{t('follow_remaining')}</span>
            <span className="follow-value">
              {formatDistance(fix.remainingM)} · +{Math.round(fix.remainingGainM)} m ·{' '}
              {formatDuration(fix.remainingHours)}
            </span>
          </div>
          {offRoute && <span className="follow-warn">{t('follow_off_route')}</span>}
        </>
      )}
      <button type="button" className="follow-stop" onClick={() => usePlanner.getState().stopFollow()}>
        {t('follow_stop')}
      </button>
    </div>
  );
}
