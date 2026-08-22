import { useState } from 'react';
import { track } from '../lib/analytics';
import { type BivouacSpot, findBivouacSpots } from '../lib/bivouac';
import { useT } from '../lib/i18n';
import { liveBivouacSpots, routeCoords, usePlanner } from '../store';

/**
 * Bivouac suggestions along the loaded route.
 *
 * The score is broken down rather than served as one number: a hiker who sees "flat, water 6
 * min, sheltered, no view" can judge it against the evening they expect, which a bare 78/100
 * never allows.
 */
export function BivouacPanel() {
  const t = useT();
  const legs = usePlanner(s => s.legs);
  const spots = usePlanner(liveBivouacSpots);
  const [status, setStatus] = useState<'idle' | 'searching' | 'terrain-only' | 'empty'>('idle');

  const coords = routeCoords(legs);
  const hasRoute = coords.length >= 2;

  async function search() {
    setStatus('searching');
    track('bivouac-search');
    const { spots: found, terrainOnly } = await findBivouacSpots(coords, usePlanner.getState().profile);
    usePlanner.getState().setBivouacSpots(found);
    setStatus(found.length === 0 ? 'empty' : terrainOnly ? 'terrain-only' : 'idle');
  }

  function place(spot: BivouacSpot) {
    const rest = spots.filter(other => other !== spot);
    usePlanner.getState().insertDetour(spot.point, 'camp');
    // a trek has more than one night: the other suggestions stay, re-keyed onto the route the
    // detour just created, so planting the second camp needs no second search
    usePlanner.getState().setBivouacSpots(rest);
  }

  return (
    <div className="mc-panel bivouac-panel">
      <h2>{t('bivouac')}</h2>
      {!hasRoute ? (
        <p className="mc-hint">{t('bivouac_no_route')}</p>
      ) : (
        <>
          <button type="button" className="bivouac-search" data-control="bivouac-search" onClick={search}>
            {status === 'searching' ? t('computing') : t('bivouac_search')}
          </button>
          {status === 'terrain-only' && <p className="mc-hint">{t('bivouac_terrain_only')}</p>}
          {status === 'empty' && <p className="mc-hint">{t('bivouac_none')}</p>}
          <ul className="bivouac-list">
            {spots.map(spot => (
              <li key={`${spot.point[0]},${spot.point[1]}`}>
                <button
                  type="button"
                  data-control="bivouac-spot"
                  title={t('bivouac_place')}
                  onClick={() => place(spot)}
                >
                  <span className="bivouac-score" style={{ background: scoreColor(spot.total) }}>
                    {spot.total}
                  </span>
                  <span className="bivouac-detail">
                    <strong>{Math.round(spot.elevation)} m</strong>
                    <small>
                      {t('bivouac_slope')} {spot.slopeDeg.toFixed(0)}°
                      {spot.waterMinutes !== null && ` · ${t('bivouac_water')} ${Math.round(spot.waterMinutes)} min`}
                    </small>
                    <small>{traits(spot, t)}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {spots.length > 0 && <p className="mc-hint">{t('bivouac_hint')}</p>}
        </>
      )}
    </div>
  );
}

/** the two or three things that actually decided this score */
function traits(spot: BivouacSpot, t: (key: 'bivouac_sheltered' | 'bivouac_view' | 'bivouac_quiet') => string): string {
  const said: string[] = [];
  if (spot.shelter > 0.6) said.push(t('bivouac_sheltered'));
  if (spot.view > 0.6) said.push(t('bivouac_view'));
  if (spot.quiet > 0.8) said.push(t('bivouac_quiet'));
  return said.join(' · ');
}

function scoreColor(total: number): string {
  if (total >= 75) return '#008300';
  if (total >= 60) return '#7cb518';
  return '#eda100';
}
