import { useEffect, useRef, useState } from 'react';
import { type MsgKey, useT } from '../lib/i18n';
import { dateLocale } from '../lib/lang';
import { renderShareImage, type ShareFormat, type ShareImageOptions } from '../lib/shareImage';
import { useEscapeKey } from '../lib/useEscapeKey';
import { routeCoords, usePlanner } from '../store';

type PresetKey = 'map' | 'satellite' | 'night' | 'trace' | 'paper';

/** curated looks, Strava-style: one swipe picks a whole layout instead of stacking options */
const PRESETS: { key: PresetKey; options: Omit<ShareImageOptions, 'format' | 'title'> }[] = [
  { key: 'map', options: { background: 'plan', showStats: true, showProfile: true } },
  { key: 'satellite', options: { background: 'satellite', showStats: true, showProfile: false } },
  { key: 'night', options: { background: 'dark', showStats: true, showProfile: true } },
  { key: 'trace', options: { background: 'dark', showStats: false, showProfile: false } },
  { key: 'paper', options: { background: 'light', showStats: true, showProfile: true } },
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
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="5" />
                <circle cx="12" cy="12" r="4.2" />
                <circle cx="17.2" cy="6.8" r="1.3" fill="currentColor" stroke="none" />
              </svg>
            </button>
            <button type="button" className="network-btn" title="WhatsApp" onClick={() => shareTo('whatsapp')}>
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2.5A9.4 9.4 0 0 0 3.9 16.7L2.5 21.5l4.9-1.3A9.4 9.4 0 1 0 12 2.5zm0 2a7.4 7.4 0 1 1-3.8 13.8l-.4-.2-2.9.8.8-2.8-.3-.4A7.4 7.4 0 0 1 12 4.5zm-2.6 3.6c-.2 0-.5 0-.7.3-.2.3-.9.9-.9 2.1s.9 2.5 1 2.6c.1.2 1.8 2.8 4.4 3.8 2.2.9 2.6.7 3.1.6.5 0 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.6-.3l-2-1c-.3-.1-.5-.1-.7.1l-.9 1.1c-.2.2-.3.2-.6.1a6 6 0 0 1-1.8-1.1 6.6 6.6 0 0 1-1.2-1.6c-.1-.3 0-.4.1-.5l.5-.6c.2-.2.2-.3.3-.5v-.5L10 8.4c-.2-.4-.4-.4-.6-.4z" />
              </svg>
            </button>
            <button type="button" className="network-btn" title="X" onClick={() => shareTo('x')}>
              <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M17.7 3H21l-7.3 8.3L22.2 21h-6.7l-5.3-6.2L4.2 21H1l7.8-8.9L1.8 3h6.9l4.8 5.7L17.7 3zm-1.2 16h1.9L6.8 4.9H4.8L16.5 19z" />
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
