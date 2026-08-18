import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../lib/i18n';
import { buildPreviewableShareUrl } from '../lib/share';
import { useEscapeKey } from '../lib/useEscapeKey';

/**
 * The route as a QR code: plan on the big screen, scan, walk out with it on the phone.
 * The code carries the same short share link the copy button hands out.
 */
export function QrPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEscapeKey(onClose, true);

  useEffect(() => {
    let stale = false;
    buildPreviewableShareUrl().then(link => {
      if (!stale) setUrl(link);
    });
    return () => {
      stale = true;
    };
  }, []);

  useEffect(() => {
    if (!url || !canvasRef.current) return;
    // the long fallback link holds the whole route: only version-capped codes stay scannable
    void QRCode.toCanvas(canvasRef.current, url, { width: 240, margin: 1, errorCorrectionLevel: 'M' }).catch(() => {
      setUrl(null);
    });
  }, [url]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close, Escape works too
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape already closes via useEscapeKey
    <div className="share-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="qr-panel" role="dialog" aria-label={t('share_qr')}>
        <div className="point-editor-head">
          <h2>{t('share_qr')}</h2>
          <button type="button" className="editor-close" title={t('close')} onClick={onClose}>
            ×
          </button>
        </div>
        <canvas ref={canvasRef} className="qr-canvas" data-control="qr-canvas" />
        <p className="side-hint">{url === null ? t('computing') : t('share_qr_hint')}</p>
      </div>
    </div>
  );
}
