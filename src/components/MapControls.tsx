import { useRef, useState } from 'react';
import { BASE_LAYER_OPTIONS, layerThumbUrl } from '../config/layers';
import { track } from '../lib/analytics';
import type { HikerPace } from '../lib/hikingTime';
import { type MsgKey, useT } from '../lib/i18n';
import { SLOPE_LEGEND } from '../lib/slopeTiles';
import { useClickOutside } from '../lib/useClickOutside';
import { useEscapeKey } from '../lib/useEscapeKey';
import { type Overlays, usePlanner } from '../store';
import { NearbyHikes } from './NearbyHikes';

type Panel = 'explore' | 'layers' | 'options' | null;

const PACES: HikerPace[] = ['strolling', 'steady', 'sporty', 'athletic'];

const OPTION_ROWS: { key: keyof Overlays; labelKey: MsgKey }[] = [
  { key: 'km', labelKey: 'opt_km' },
  { key: 'contours', labelKey: 'opt_contours' },
  { key: 'hillshade', labelKey: 'opt_hillshade' },
  { key: 'slopes', labelKey: 'opt_slopes' },
  { key: 'gr', labelKey: 'opt_gr' },
  { key: 'refuges', labelKey: 'opt_refuges' },
  { key: 'terrain3d', labelKey: 'opt_3d' },
];

export function MapControls({ onPanelOpen }: { onPanelOpen?: () => void } = {}) {
  const t = useT();
  const [open, setOpen] = useState<Panel>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const baseLayerId = usePlanner(s => s.baseLayerId);
  const overlays = usePlanner(s => s.overlays);
  const flyover = usePlanner(s => s.flyover);
  const flyoverPaused = usePlanner(s => s.flyoverPaused);
  const following = usePlanner(s => s.following);
  const profile = usePlanner(s => s.profile);
  const legs = usePlanner(s => s.legs);
  useClickOutside(rootRef, () => setOpen(null), open !== null);
  useEscapeKey(() => setOpen(null), open !== null);
  useEscapeKey(() => usePlanner.getState().stopFlyover(), flyover);
  const hasRoute = legs.some(l => (l.leg?.coords.length ?? 0) > 0);

  function togglePanel(panel: Exclude<Panel, null>) {
    const next = open === panel ? null : panel;
    setOpen(next);
    // the marked-trail tiles give the list a visual counterpart, so reading a name and seeing
    // where it runs is one gesture instead of two
    if (next === 'explore') usePlanner.getState().setOverlay('gr', true);
    // one thing at a time on a phone: a panel and an open sheet would fight for the screen
    if (next) onPanelOpen?.();
  }

  return (
    <div className="map-controls" ref={rootRef}>
      <button
        type="button"
        className="mc-btn"
        data-control="focus"
        aria-label={t('focus_route')}
        data-tip={t('focus_route')}
        disabled={!hasRoute}
        onClick={() => usePlanner.getState().focusRoute()}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
          <path d="M7 14.5c2.5-6 5 4 10-5" />
        </svg>
      </button>
      <button
        type="button"
        className={flyover ? 'mc-btn active' : 'mc-btn'}
        data-control="flyover"
        aria-label={flyover ? (flyoverPaused ? t('flyover_resume') : t('flyover_pause')) : t('flyover')}
        data-tip={flyover ? (flyoverPaused ? t('flyover_resume') : t('flyover_pause')) : t('flyover')}
        disabled={!hasRoute}
        onClick={() => {
          if (flyover) return usePlanner.getState().setFlyoverPaused(!flyoverPaused);
          track('flyover');
          usePlanner.getState().toggleFlyover();
        }}
      >
        {flyover && !flyoverPaused ? (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="5" width="4" height="14" rx="1" />
            <rect x="14" y="5" width="4" height="14" rx="1" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5.5v13l11-6.5z" />
          </svg>
        )}
      </button>
      {flyover && (
        <button
          type="button"
          className="mc-btn"
          data-control="flyover-stop"
          aria-label={t('flyover_stop')}
          data-tip={t('flyover_stop')}
          onClick={() => usePlanner.getState().stopFlyover()}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="1.5" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className={following ? 'mc-btn active' : 'mc-btn'}
        data-control="follow"
        aria-label={t('follow')}
        data-tip={t('follow')}
        disabled={!hasRoute}
        onClick={() => usePlanner.getState().toggleFollow()}
      >
        {/* a position *on a path*: the crosshair of the geolocate control above answers "where
            am I", this one answers "where am I along this route" */}
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 20c3.5 0 3-6 7-6s3.5-8 8-8" strokeDasharray="3 3" />
          <circle cx="10" cy="14" r="3.4" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <button
        type="button"
        className={open === 'explore' ? 'mc-btn active' : 'mc-btn'}
        data-control="explore"
        aria-label={t('nearby_hikes')}
        data-tip={t('nearby_hikes')}
        onClick={() => togglePanel('explore')}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="m15.5 8.5-2 5-5 2 2-5z" />
        </svg>
      </button>
      <button
        type="button"
        className={open === 'layers' ? 'mc-btn active' : 'mc-btn'}
        data-control="layers"
        aria-label={t('basemaps')}
        data-tip={t('basemaps')}
        onClick={() => togglePanel('layers')}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m12 3 9 5-9 5-9-5 9-5z" />
          <path d="m3 13.5 9 5 9-5" />
        </svg>
      </button>
      <button
        type="button"
        className={open === 'options' ? 'mc-btn active' : 'mc-btn'}
        data-control="options"
        aria-label={t('display_options')}
        data-tip={t('display_options')}
        onClick={() => togglePanel('options')}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4 7h8M17.5 7H20M4 17h2.5M12 17h8" />
          <circle cx="14.5" cy="7" r="2.2" />
          <circle cx="8.5" cy="17" r="2.2" />
        </svg>
      </button>

      {open === 'explore' && (
        <div className="mc-panel">
          <h2>{t('nearby_hikes')}</h2>
          <NearbyHikes onLoaded={() => setOpen(null)} />
        </div>
      )}

      {open === 'layers' && (
        <div className="mc-panel">
          <h2>{t('basemaps')}</h2>
          <div className="layer-cards">
            {BASE_LAYER_OPTIONS.map(l => (
              <button
                key={l.id}
                type="button"
                className={l.id === baseLayerId ? 'layer-card selected' : 'layer-card'}
                onClick={() => usePlanner.getState().setBaseLayerId(l.id)}
              >
                <img src={layerThumbUrl(l.id)} alt="" loading="lazy" />
                <span>{t(l.labelKey)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {open === 'options' && (
        <div className="mc-panel">
          <h2>{t('display_options')}</h2>
          {OPTION_ROWS.map(o => (
            <label key={o.key} className="option-row">
              <span>{t(o.labelKey)}</span>
              <input
                type="checkbox"
                checked={overlays[o.key]}
                onChange={() => usePlanner.getState().toggleOverlay(o.key)}
              />
            </label>
          ))}
          {overlays.refuges && <p className="mc-hint">{t('opt_poi_hint')}</p>}
          <h2 className="mc-subhead">{t('hiker_profile')}</h2>
          <div className="segmented wrap">
            {PACES.map(pace => (
              <button
                key={pace}
                type="button"
                className={profile.pace === pace ? 'on' : ''}
                onClick={() => usePlanner.getState().setProfile({ ...profile, pace })}
              >
                {t(`pace_${pace}` as MsgKey)}
              </button>
            ))}
          </div>
          <div className="profile-fields">
            <label>
              {t('profile_weight')}
              <input
                type="number"
                min={30}
                max={200}
                value={profile.weightKg}
                onChange={e => usePlanner.getState().setProfile({ ...profile, weightKg: Number(e.target.value) })}
              />
            </label>
            <label>
              {t('profile_pack')}
              <input
                type="number"
                min={0}
                max={60}
                value={profile.packKg}
                onChange={e => usePlanner.getState().setProfile({ ...profile, packKg: Number(e.target.value) })}
              />
            </label>
          </div>
          <p className="mc-hint">{t('profile_hint')}</p>
          {overlays.slopes && (
            <div className="slope-legend">
              {SLOPE_LEGEND.map((c, i) => (
                <span key={c.label} className="slope-chip">
                  <i style={{ background: c.color }} />
                  {i === 0 ? t('legend_flat') : c.label}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
