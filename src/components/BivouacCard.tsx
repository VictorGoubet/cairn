import { useEffect, useState } from 'react';
import { ORTHO_RASTER_TILES } from '../config/layers';
import { type BivouacSpot, ON_PLAN_M } from '../lib/bivouac';
import { formatDistance } from '../lib/geo';
import { useT } from '../lib/i18n';
import { type GroundPhoto, nearestGroundPhoto } from '../lib/panoramax';
import { useEscapeKey } from '../lib/useEscapeKey';
import { liveBivouacSpots, usePlanner } from '../store';

/** deep enough that grass, scree and trees are told apart */
const PHOTO_ZOOM = 18;

/**
 * The card of one suggestion: what the score is made of, what the ground looks like, and the
 * one action that changes the route.
 *
 * Two pictures, in that order: a ground photo from Panoramax when a hiker has passed with a
 * camera within a couple of hundred metres (with the distance said out loud, since it is not the
 * spot itself), and otherwise the IGN orthophoto of the exact tile, which shows the ground you
 * would pitch on. The orthophoto covers France only, so a spot on the Swiss side drops the image
 * rather than showing a broken one.
 */
export function BivouacCard() {
  const t = useT();
  const selected = usePlanner(s => s.bivouacSelected);
  const live = usePlanner(liveBivouacSpots);
  const [photoFailed, setPhotoFailed] = useState(false);
  const [ground, setGround] = useState<GroundPhoto | null>(null);
  useEscapeKey(() => usePlanner.getState().setBivouacSelected(null), selected !== null);

  useEffect(() => {
    if (!selected) return;
    let stale = false;
    setGround(null);
    setPhotoFailed(false);
    nearestGroundPhoto(selected.point).then(photo => {
      if (!stale) setGround(photo);
    });
    return () => {
      stale = true;
    };
  }, [selected]);

  // editing the route retires the whole search: a card left open would offer to move a night
  // that was scored for another itinerary
  if (!selected || !live.includes(selected)) return null;
  const spot = selected;

  function move() {
    usePlanner.getState().moveAnchorTo(spot.campId, spot.point);
    // the other suggestions for that same night are spent, the other nights keep theirs
    usePlanner
      .getState()
      .setBivouacSpots(usePlanner.getState().bivouacSpots.filter(other => other.campId !== spot.campId));
  }

  return (
    <div className="bivouac-card" data-control="bivouac-card">
      <div className="point-editor-head">
        <h2>
          <span className="bivouac-score" style={{ background: spot.total >= 60 ? '#008300' : '#eda100' }}>
            {spot.total}
          </span>
          {Math.round(spot.elevation)} m
        </h2>
        <button
          type="button"
          className="editor-close"
          title={t('close')}
          onClick={() => usePlanner.getState().setBivouacSelected(null)}
        >
          ×
        </button>
      </div>
      {ground ? (
        <figure className="bivouac-shot">
          <img className="bivouac-photo" src={ground.thumbUrl} alt={t('bivouac_photo_ground')} loading="lazy" />
          <figcaption>
            <a href={ground.viewerUrl} target="_blank" rel="noreferrer">
              Panoramax
            </a>
            {` · ${ground.author} · ${ground.license} · ${formatDistance(ground.distanceM)}`}
          </figcaption>
        </figure>
      ) : (
        !photoFailed && (
          <img
            className="bivouac-photo"
            src={photoUrl(spot)}
            alt={t('bivouac_photo')}
            loading="lazy"
            onError={() => setPhotoFailed(true)}
          />
        )
      )}
      <ul className="bivouac-criteria">
        <Criterion label={t('bivouac_slope')} value={`${spot.slopeDeg.toFixed(0)}°`} share={spot.flatness} />
        <Criterion
          label={t('bivouac_water')}
          value={spot.waterMinutes === null ? '—' : `${Math.round(spot.waterMinutes)} min`}
          share={spot.water}
        />
        <Criterion label={t('bivouac_sheltered')} share={spot.shelter} />
        <Criterion label={t('bivouac_view')} share={spot.view} />
        <Criterion label={t('bivouac_quiet')} share={spot.quiet} />
      </ul>
      <p className="side-hint">
        {spot.shiftM < ON_PLAN_M ? t('bivouac_on_plan') : `${t('bivouac_shift')} ${formatDistance(spot.shiftM)}`}
        {spot.campName && ` · ${spot.campName}`}
      </p>
      <button type="button" className="bivouac-move" data-control="bivouac-move" onClick={move}>
        {t('bivouac_move')}
      </button>
    </div>
  );
}

function Criterion({ label, value, share }: { label: string; value?: string; share: number }) {
  return (
    <li>
      <span className="criterion-label">{label}</span>
      <span className="criterion-bar">
        <span style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      {value && <span className="criterion-value">{value}</span>}
    </li>
  );
}

function photoUrl(spot: BivouacSpot): string {
  const n = 2 ** PHOTO_ZOOM;
  const x = Math.floor(((spot.point[0] + 180) / 360) * n);
  const rad = (spot.point[1] * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return ORTHO_RASTER_TILES.replace('{z}', String(PHOTO_ZOOM)).replace('{x}', String(x)).replace('{y}', String(y));
}
