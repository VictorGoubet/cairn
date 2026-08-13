import { useEffect, useRef, useState } from 'react';
import { track } from '../lib/analytics';
import { type MsgKey, useT } from '../lib/i18n';
import { dateLocale } from '../lib/lang';
import { renderShareImage, type ShareFormat, type ShareImageOptions } from '../lib/shareImage';
import { useEscapeKey } from '../lib/useEscapeKey';
import { routeCoords, usePlanner } from '../store';

type PresetKey = 'map' | 'satellite' | 'overlay' | 'trace' | 'paper' | 'relief';

/** curated looks, Strava-style: one swipe picks a whole layout instead of stacking options */
const PRESETS: { key: PresetKey; options: Omit<ShareImageOptions, 'format' | 'title'> }[] = [
  { key: 'map', options: { background: 'plan', showStats: true, showProfile: true } },
  { key: 'satellite', options: { background: 'satellite', showStats: true, showProfile: false } },
  { key: 'overlay', options: { background: 'transparent', showStats: true, showProfile: true } },
  { key: 'trace', options: { background: 'transparent', showStats: false, showProfile: false } },
  { key: 'paper', options: { background: 'light', showStats: true, showProfile: true } },
  { key: 'relief', options: { background: 'relief', showStats: true, showProfile: false } },
];

const FORMATS: ShareFormat[] = ['square', 'story'];

type Network = 'instagram' | 'whatsapp' | 'x';

const NETWORK_SITES: Record<Network, string> = {
  instagram: 'https://www.instagram.com/',
  whatsapp: 'https://web.whatsapp.com/',
  x: 'https://x.com/compose/post',
};

/**
 * The share-image studio: composes a social tile of the route and hands it out.
 *
 * Args:
 *   onClose: called when the panel should disappear.
 */
export function SharePanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const lang = usePlanner(s => s.lang);
  const legs = usePlanner(s => s.legs);
  const currentRouteName = usePlanner(s => s.currentRouteName);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [presetIndex, setPresetIndex] = useState(0);
  const [format, setFormat] = useState<ShareFormat>('square');
  const [feedback, setFeedback] = useState<'copied' | 'failed' | null>(null);
  useEscapeKey(onClose, true);

  const preset = PRESETS[presetIndex];
  const title = currentRouteName || `${t('route_of')} ${new Date().toLocaleDateString(dateLocale(lang))}`;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const coords = routeCoords(legs);
    if (coords.length < 2) return;
    const options: ShareImageOptions = { format, title, ...PRESETS[presetIndex].options };
    // tiles arrive asynchronously: compose off-screen and blit only if still current, otherwise
    // two renders in flight would interleave their drawing on the visible canvas
    let stale = false;
    const scratch = document.createElement('canvas');
    renderShareImage(scratch, coords, options).then(() => {
      if (stale) return;
      canvas.width = scratch.width;
      canvas.height = scratch.height;
      canvas.getContext('2d')?.drawImage(scratch, 0, 0);
    });
    return () => {
      stale = true;
    };
  }, [format, presetIndex, title, legs]);

  async function toBlob(): Promise<Blob> {
    const canvas = canvasRef.current;
    if (!canvas) throw new Error('no canvas');
    return await new Promise((resolve, reject) => {
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('empty canvas'))), 'image/png');
    });
  }

  async function copyImage(): Promise<boolean> {
    try {
      // Safari requires the promise form: the clipboard call must be synchronous with the click
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': toBlob() })]);
      track('share-image', { how: 'copy', preset: PRESETS[presetIndex].key, format });
      setFeedback('copied');
      setTimeout(() => setFeedback(null), 2500);
      return true;
    } catch {
      setFeedback('failed');
      setTimeout(() => setFeedback(null), 2500);
      return false;
    }
  }

  async function shareTo(network: Network) {
    // a phone hands the image straight to the app through the native sheet; a desktop cannot
    // upload into a social site, so the image lands in the clipboard and the site opens
    track('share-image', { how: network, preset: PRESETS[presetIndex].key, format });
    try {
      const file = new File([await toBlob()], 'cairn.png', { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'cairn' });
        return;
      }
    } catch {
      return;
    }
    if (await copyImage()) window.open(NETWORK_SITES[network], '_blank', 'noopener');
  }

  async function downloadImage() {
    track('share-image', { how: 'download', preset: PRESETS[presetIndex].key, format });
    const url = URL.createObjectURL(await toBlob());
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cairn.png';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close, Escape works too
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape already closes via useEscapeKey
    <div className="share-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="share-panel" role="dialog" aria-label={t('si_title')}>
        <div className="share-head">
          <h3>{t('si_title')}</h3>
          <div className="segmented">
            {FORMATS.map(f => (
              <button key={f} type="button" className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>
                {t(`si_fmt_${f}` as MsgKey)}
              </button>
            ))}
          </div>
          <button type="button" className="share-close" aria-label={t('close')} onClick={onClose}>
            ×
          </button>
        </div>

        <div className="share-carousel">
          <button
            type="button"
            className="carousel-arrow"
            aria-label="‹"
            onClick={() => setPresetIndex(i => (i + PRESETS.length - 1) % PRESETS.length)}
          >
            ‹
          </button>
          <div className={`share-preview ${format}`}>
            <canvas ref={canvasRef} data-control="share-canvas" />
          </div>
          <button
            type="button"
            className="carousel-arrow"
            data-control="share-next"
            aria-label="›"
            onClick={() => setPresetIndex(i => (i + 1) % PRESETS.length)}
          >
            ›
          </button>
        </div>
        <div className="carousel-nav">
          <span className="carousel-name">{t(`si_preset_${preset.key}` as MsgKey)}</span>
          <div className="carousel-dots">
            {PRESETS.map((p, i) => (
              <button
                key={p.key}
                type="button"
                className={i === presetIndex ? 'dot on' : 'dot'}
                aria-label={t(`si_preset_${p.key}` as MsgKey)}
                onClick={() => setPresetIndex(i)}
              />
            ))}
          </div>
        </div>

        <div className="share-actions-row">
          <button type="button" className="primary" onClick={copyImage}>
            {feedback === 'copied' ? t('si_copied') : feedback === 'failed' ? t('si_copy_failed') : t('si_copy')}
          </button>
          <div className="share-networks">
            <button type="button" className="network-btn" title="Instagram" onClick={() => shareTo('instagram')}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <defs>
                  <radialGradient id="ig-grad" cx="0.3" cy="1.1" r="1.3">
                    <stop offset="0" stopColor="#fdd575" />
                    <stop offset="0.26" stopColor="#fa7e1e" />
                    <stop offset="0.55" stopColor="#d62976" />
                    <stop offset="0.8" stopColor="#962fbf" />
                    <stop offset="1" stopColor="#4f5bd5" />
                  </radialGradient>
                </defs>
                <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="url(#ig-grad)" />
                <rect x="6.2" y="6.2" width="11.6" height="11.6" rx="3.6" fill="none" stroke="#fff" strokeWidth="1.8" />
                <circle cx="12" cy="12" r="2.9" fill="none" stroke="#fff" strokeWidth="1.8" />
                <circle cx="16.1" cy="7.9" r="1.15" fill="#fff" />
              </svg>
            </button>
            <button type="button" className="network-btn" title="WhatsApp" onClick={() => shareTo('whatsapp')}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="10.5" fill="#25d366" />
                <path
                  fill="#fff"
                  d="M12 4.8a7.1 7.1 0 0 0-6.1 10.7l-1 3.7 3.8-1a7.1 7.1 0 1 0 3.3-13.4zm0 1.6a5.5 5.5 0 1 1-2.9 10.2l-.3-.2-2.2.6.6-2.1-.2-.3A5.5 5.5 0 0 1 12 6.4zM10 8.6c-.2 0-.4 0-.6.2-.2.2-.7.7-.7 1.6s.7 1.9.8 2c.1.1 1.4 2.1 3.3 2.9 1.7.7 2 .5 2.3.5.4 0 1.2-.5 1.3-.9.2-.5.2-.9.1-1 0 0-.2-.1-.4-.2l-1.5-.7c-.2-.1-.4-.1-.5.1l-.7.8c-.1.2-.3.2-.4.1a4.5 4.5 0 0 1-1.4-.9 5 5 0 0 1-.9-1.2c-.1-.2 0-.3.1-.4l.4-.5c.1-.2.1-.3.2-.4v-.4L10.5 9c-.1-.3-.3-.4-.5-.4z"
                />
              </svg>
            </button>
            <button type="button" className="network-btn" title="X" onClick={() => shareTo('x')}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="1.5" y="1.5" width="21" height="21" rx="6" fill="#0f1419" />
                <path
                  fill="#fff"
                  d="M15.9 5.5h2.2l-4.8 5.6 5.7 7.4h-4.5l-3.5-4.5-4 4.5H4.8l5.2-5.9-5.5-7.1H9l3.2 4.1 3.7-4.1zm-.8 11.7h1.2L8.4 6.7H7.1l8 10.5z"
                />
              </svg>
            </button>
          </div>
          <button type="button" onClick={downloadImage}>
            {t('si_download')}
          </button>
        </div>
      </div>
    </div>
  );
}
