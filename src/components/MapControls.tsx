import { useRef, useState } from 'react';
import { BASE_LAYER_OPTIONS, layerThumbUrl } from '../config/layers';
import { type MsgKey, useT } from '../lib/i18n';
import { SLOPE_LEGEND } from '../lib/slopeTiles';
import { useClickOutside } from '../lib/useClickOutside';
import { useEscapeKey } from '../lib/useEscapeKey';
import { type Overlays, usePlanner } from '../store';

const OPTION_ROWS: { key: keyof Overlays; labelKey: MsgKey }[] = [
  { key: 'km', labelKey: 'opt_km' },
  { key: 'contours', labelKey: 'opt_contours' },
  { key: 'hillshade', labelKey: 'opt_hillshade' },
  { key: 'slopes', labelKey: 'opt_slopes' },
  { key: 'gr', labelKey: 'opt_gr' },
  { key: 'hidden', labelKey: 'opt_hidden' },
  { key: 'refuges', labelKey: 'opt_refuges' },
  { key: 'terrain3d', labelKey: 'opt_3d' },
];

export function MapControls({ onPanelOpen }: { onPanelOpen?: () => void } = {}) {
  const t = useT();
  const [open, setOpen] = useState<'layers' | 'options' | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const baseLayerId = usePlanner(s => s.baseLayerId);
  const overlays = usePlanner(s => s.overlays);
  const flyover = usePlanner(s => s.flyover);
  const flyoverPaused = usePlanner(s => s.flyoverPaused);
  const legs = usePlanner(s => s.legs);
  useClickOutside(rootRef, () => setOpen(null), open !== null);
  useEscapeKey(() => setOpen(null), open !== null);
  useEscapeKey(() => usePlanner.getState().stopFlyover(), flyover);
  const hasRoute = legs.some(l => (l.leg?.coords.length ?? 0) > 0);

  function togglePanel(panel: 'layers' | 'options') {
    const next = open === panel ? null : panel;
    setOpen(next);
    // one thing at a time on a phone: a panel and an open sheet would fight for the screen
    if (next) onPanelOpen?.();
  }

  return (
    <div className="map-controls" ref={rootRef}>
      <button
        type="button"
        className="mc-btn"
        data-control="focus"
        title={t('focus_route')}
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
        title={flyover ? (flyoverPaused ? t('flyover_resume') : t('flyover_pause')) : t('flyover')}
        disabled={!hasRoute}
        onClick={() =>
          flyover ? usePlanner.getState().setFlyoverPaused(!flyoverPaused) : usePlanner.getState().toggleFlyover()
        }
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
          title={t('flyover_stop')}
          onClick={() => usePlanner.getState().stopFlyover()}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="1.5" />
          </svg>
        </button>
      )}
      <button
        type="button"
        className={open === 'layers' ? 'mc-btn active' : 'mc-btn'}
        data-control="layers"
        title={t('basemaps')}
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
        title={t('display_options')}
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
          {(overlays.hidden || overlays.refuges) && <p className="mc-hint">{t('opt_poi_hint')}</p>}
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
