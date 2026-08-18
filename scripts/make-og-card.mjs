// Renders public/og.jpg, the 1200x630 card chat apps and social networks show for the site
// itself (a shared *route* gets its own tile, drawn in the browser: see lib/shareImage.ts).
// Run it with `make og-card` after touching the logo or the pitch.
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const CARD = { width: 1200, height: 630 };
// jpeg, and under the ~300 kB a preview crawler is willing to fetch on a phone
const QUALITY = 90;

const logo = readFileSync(new URL('../public/logo.png', import.meta.url)).toString('base64');

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; box-sizing: border-box; }
  body {
    width: ${CARD.width}px; height: ${CARD.height}px; overflow: hidden; position: relative;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(155deg, #fdfcfa 0%, #f7f2ea 60%, #fdf0e3 100%);
  }
  .row { display: flex; align-items: center; gap: 60px; padding: 74px 84px 0; }
  img { width: 268px; height: 268px; flex-shrink: 0; }
  h1 { font-size: 100px; font-weight: 800; letter-spacing: -2px; color: #212529; line-height: 1; }
  p { font-size: 40px; color: #52514e; margin-top: 20px; line-height: 1.3; max-width: 620px; }
  .rule { width: 124px; height: 7px; border-radius: 4px; background: #e8590c; margin-top: 28px; }
  /* the app is bilingual, so the card says it once in each language */
  .fr { font-size: 28px; color: #7d7b74; margin-top: 26px; letter-spacing: 0.2px; }
  /* the relief and the trace of the app itself, so the card reads as a hiking tool */
  svg { position: absolute; left: 0; bottom: 0; width: 100%; height: 250px; }
</style></head>
<body>
  <div class="row">
    <img src="data:image/png;base64,${logo}" alt="">
    <div>
      <h1>cairn</h1>
      <p>Free hiking and trek planner</p>
      <div class="rule"></div>
      <div class="fr">Planificateur de rando et trek gratuit</div>
    </div>
  </div>
  <svg viewBox="0 0 1200 250" preserveAspectRatio="none">
    <path d="M0 205 L120 150 L215 185 L340 96 L470 172 L600 120 L720 178 L860 108 L980 165 L1090 128 L1200 176 L1200 250 L0 250 Z"
          fill="#e6e2d7" opacity="0.75"/>
    <path d="M44 224 C160 214 210 190 300 196 S430 168 500 186 S620 150 700 172 S840 158 920 148 S1080 168 1156 140"
          fill="none" stroke="#e34948" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="44" cy="224" r="12" fill="#2b9348" stroke="#fff" stroke-width="5"/>
    <circle cx="1156" cy="140" r="12" fill="#212529" stroke="#fff" stroke-width="5"/>
  </svg>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: CARD, deviceScaleFactor: 1 });
await page.setContent(HTML, { waitUntil: 'load' });
const jpg = await page.screenshot({ type: 'jpeg', quality: QUALITY });
await browser.close();

const out = new URL('../public/og.jpg', import.meta.url);
writeFileSync(out, jpg);
console.log(`wrote ${out.pathname} (${Math.round(jpg.length / 1024)} kB)`);
