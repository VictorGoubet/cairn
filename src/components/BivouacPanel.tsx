import { useState } from 'react';
import { track } from '../lib/analytics';
import { type BivouacGroup, type BivouacSpot, findBivouacSpots, ON_PLAN_M, type PlannedCamp } from '../lib/bivouac';
import { formatDistance } from '../lib/geo';
import { type MsgKey, useT } from '../lib/i18n';
import { liveBivouacSpots, plannedCamps, routeCoords, usePlanner } from '../store';

/**
 * Better spots for the camps already planned.
 *
 * The days are the hiker's to cut: this only refines where each night lands. A row focuses the
 * map on the spot and opens its card; nothing moves until the card says so.
 */
export function BivouacPanel() {
  const t = useT();
  const legs = usePlanner(s => s.legs);
  const anchors = usePlanner(s => s.anchors);
  const spots = usePlanner(liveBivouacSpots);
  const [status, setStatus] = useState<'idle' | 'searching' | 'terrain-only' | 'empty'>('idle');

  const coords = routeCoords(legs);
  const camps = plannedCamps(anchors, legs);
  // rebuilt from the store on every render rather than kept here: a search survives closing the
  // panel, dies with the itinerary it was made for, and a night that has been moved drops its
  // rows at the same moment as its markers
  const groups = groupByCamp(spots, camps);

  async function search() {
    setStatus('searching');
    track('bivouac-search', { camps: camps.length });
    const found = await findBivouacSpots(coords, camps, usePlanner.getState().profile);
    usePlanner.getState().setBivouacSpots(found.groups.flatMap(group => group.spots));
    setStatus(found.groups.length === 0 ? 'empty' : found.terrainOnly ? 'terrain-only' : 'idle');
  }

  function reveal(spot: BivouacSpot) {
    usePlanner.getState().setFlyTo({ center: spot.point, zoom: 16 });
    usePlanner.getState().setBivouacSelected(spot);
  }

  if (camps.length === 0) {
    return (
      <div className="mc-panel bivouac-panel">
        <h2>{t('bivouac')}</h2>
        <p className="mc-hint">{coords.length < 2 ? t('bivouac_no_route') : t('bivouac_no_camps')}</p>
      </div>
    );
  }

  return (
    <div className="mc-panel bivouac-panel">
      <h2>{t('bivouac')}</h2>
      <button type="button" className="bivouac-search" data-control="bivouac-search" onClick={search}>
        {status === 'searching' ? t('computing') : t('bivouac_search')}
      </button>
      {status === 'terrain-only' && <p className="mc-hint">{t('bivouac_terrain_only')}</p>}
      {status === 'empty' && <p className="mc-hint">{t('bivouac_none')}</p>}
      {groups.map(group => (
        <div key={group.campId} className="bivouac-group">
          <h3>
            {t('day_prefix')}
            {group.day}
            {group.campName && ` · ${group.campName}`}
          </h3>
          <ul className="bivouac-list">
            {group.spots.map(spot => (
              <li key={`${spot.point[0]},${spot.point[1]}`}>
                <button
                  type="button"
                  data-control="bivouac-spot"
                  title={t('bivouac_reveal')}
                  onClick={() => reveal(spot)}
                >
                  <span className="bivouac-score" style={{ background: scoreColor(spot.total) }}>
                    {spot.total}
                  </span>
                  <span className="bivouac-detail">
                    <strong>
                      {Math.round(spot.elevation)} m · {shift(spot, t)}
                    </strong>
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
        </div>
      ))}
      {groups.length > 0 && <p className="mc-hint">{t('bivouac_hint')}</p>}
    </div>
  );
}

/** the suggestions still standing, under the camp and the day each belongs to */
function groupByCamp(spots: BivouacSpot[], camps: PlannedCamp[]): BivouacGroup[] {
  return camps
    .map((camp, index) => ({
      campId: camp.id,
      campName: camp.name,
      day: index + 1,
      spots: spots.filter(spot => spot.campId === camp.id),
    }))
    .filter(group => group.spots.length > 0);
}

/** how far this would move the night, which is what a planned trek cares about */
function shift(spot: BivouacSpot, t: (key: MsgKey) => string): string {
  return spot.shiftM < ON_PLAN_M ? t('bivouac_on_plan') : formatDistance(spot.shiftM);
}

/** the two or three things that actually decided this score */
function traits(spot: BivouacSpot, t: (key: MsgKey) => string): string {
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
