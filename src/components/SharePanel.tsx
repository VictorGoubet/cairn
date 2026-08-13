import { useEffect, useRef, useState } from 'react';
import { type MsgKey, useT } from '../lib/i18n';
import { dateLocale } from '../lib/lang';
import { renderShareImage, type ShareBackground, type ShareFormat, type ShareImageOptions } from '../lib/shareImage';
import { useEscapeKey } from '../lib/useEscapeKey';
import { routeCoords, usePlanner } from '../store';

const BACKGROUNDS: ShareBackground[] = ['plan', 'satellite', 'dark', 'light'];
const FORMATS: ShareFormat[] = ['square', 'story'];

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
  const [format, setFormat] = useState<ShareFormat>('square');
  const [background, setBackground] = useState<ShareBackground>('plan');
  const [showStats, setShowStats] = useState(true);
  const [showProfile, setShowProfile] = useState(true);
  const [feedback, setFeedback] = useState<'copied' | 'failed' | null>(null);
  useEscapeKey(onClose, true);

  const title = currentRouteName || `${t('route_of')} ${new Date().toLocaleDateString(dateLocale(lang))}`;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const coords = routeCoords(legs);
    if (coords.length < 2) return;
    const options: ShareImageOptions = { format, background, showStats, showProfile, title };
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
  }, [format, background, showStats, showProfile, title, legs]);

  async function toBlob(): Promise<Blob> {
    const canvas = canvasRef.current;
    if (!canvas) throw new Error('no canvas');
    return await new Promise((resolve, reject) => {
      canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('empty canvas'))), 'image/png');
    });
  }

  async function copyImage() {
    try {
      // Safari requires the promise form: the clipboard call must be synchronous with the click
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': toBlob() })]);
      setFeedback('copied');
    } catch {
      setFeedback('failed');
    }
    setTimeout(() => setFeedback(null), 2000);
  }

  async function shareImage() {
    try {
      const file = new File([await toBlob()], 'cairn.png', { type: 'image/png' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'cairn' });
      } else {
        await copyImage();
      }
    } catch {
      // the user closing the native sheet is not an error worth surfacing
    }
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
          <button type="button" className="share-close" aria-label={t('close')} onClick={onClose}>
            ×
          </button>
        </div>
        <div className="share-body">
          <div className={`share-preview ${format}`}>
            <canvas ref={canvasRef} data-control="share-canvas" />
          </div>
          <div className="share-options">
            <div className="segmented">
              {FORMATS.map(f => (
                <button key={f} type="button" className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>
                  {t(`si_fmt_${f}` as MsgKey)}
                </button>
              ))}
            </div>
            <div className="segmented">
              {BACKGROUNDS.map(b => (
                <button key={b} type="button" className={background === b ? 'on' : ''} onClick={() => setBackground(b)}>
                  {t(`si_bg_${b}` as MsgKey)}
                </button>
              ))}
            </div>
            <label className="share-toggle">
              <input type="checkbox" checked={showStats} onChange={e => setShowStats(e.target.checked)} />
              {t('si_stats')}
            </label>
            <label className="share-toggle">
              <input type="checkbox" checked={showProfile} onChange={e => setShowProfile(e.target.checked)} />
              {t('si_profile')}
            </label>
            <div className="share-actions">
              <button type="button" className="primary" onClick={copyImage}>
                {feedback === 'copied' ? t('si_copied') : feedback === 'failed' ? t('si_copy_failed') : t('si_copy')}
              </button>
              <button type="button" onClick={shareImage}>
                {t('si_share')}
              </button>
              <button type="button" onClick={downloadImage}>
                {t('si_download')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
