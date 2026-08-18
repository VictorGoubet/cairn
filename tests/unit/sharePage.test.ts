import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readShare, shareId, validId } from '../../api/_kv.js';
import { sharePage } from '../../api/s.js';

/** the very page vercel serves, so the test breaks if its head stops matching the injection */
const INDEX = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

const TITLE = 'Tour du Queyras · cairn';
const DESCRIPTION = '130 km · +7 200 m · 42 h 10';
const IMAGE = 'https://cairn.test/p/abc1234567.jpg';
const PAGE_URL = 'https://cairn.test/s/abc1234567';

describe('sharePage', () => {
  it('dresses the app page with the route own title, description and thumbnail', () => {
    const html = sharePage(INDEX, 'abc1234567', TITLE, DESCRIPTION, IMAGE, PAGE_URL);
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain(`<meta property="og:title" content="${TITLE}">`);
    expect(html).toContain(`<meta property="og:image" content="${IMAGE}">`);
    expect(html).toContain(`<meta property="og:url" content="${PAGE_URL}">`);
    expect(html).toContain('<meta property="og:image:type" content="image/jpeg">');
    expect(html).toContain(`<meta property="og:description" content="${DESCRIPTION}">`);
    // and it is still the app: the bundle entry survives the rewrite
    expect(html).toContain('/src/main.tsx');
  });

  it('leaves exactly one of every tag a preview bot reads', () => {
    const html = sharePage(INDEX, 'abc1234567', TITLE, DESCRIPTION, IMAGE, PAGE_URL);
    for (const tag of ['property="og:title"', 'property="og:image"', 'property="og:description"', '<title>']) {
      expect(html.split(tag)).toHaveLength(2);
    }
    // the generic tags the static page carries must not compete with the route own
    expect(html).not.toContain('free hiking and trek planner');
    expect(html).not.toContain('vercel.app/og.jpg');
  });

  it('escapes a route name that would break the document', () => {
    const html = sharePage(INDEX, 'abc1234567', 'Col "haut" & <raide>', DESCRIPTION, IMAGE, PAGE_URL);
    expect(html).toContain('<meta property="og:title" content="Col &quot;haut&quot; &amp; &lt;raide&gt;">');
  });

  it('still previews and still opens when the app page cannot be read', () => {
    const html = sharePage(null, 'abc1234567', TITLE, DESCRIPTION, IMAGE, PAGE_URL);
    expect(html).toContain(`<meta property="og:image" content="${IMAGE}">`);
    expect(html).toContain('content="0;url=/#s=abc1234567"');
  });

  it('sends a visitor home rather than nowhere when the link has no usable id', () => {
    expect(sharePage(null, '../secret', TITLE, DESCRIPTION, IMAGE, PAGE_URL)).toContain('content="0;url=/"');
  });
});

describe('the card the site itself previews with', () => {
  it('is what index.html advertises, at the size and weight crawlers accept', () => {
    expect(INDEX).toContain('content="https://cairn-swart-gamma.vercel.app/og.jpg"');
    expect(INDEX).toContain('<meta name="twitter:card" content="summary_large_image" />');

    const card = readFileSync(resolve(process.cwd(), 'public/og.jpg'));
    // whatsapp gives up past ~300 kB, and every platform wants 1200x630 to show it uncropped
    expect(card.length).toBeLessThan(300_000);
    expect(jpegSize(card)).toEqual({ width: 1200, height: 630 });
  });
});

describe('shareId', () => {
  it('gives the same itinerary the same link, so sharing twice stores one record', () => {
    expect(shareId('payload-of-a-route')).toBe(shareId('payload-of-a-route'));
    expect(shareId('payload-of-a-route')).not.toBe(shareId('payload-of-another-route'));
  });

  it('produces an id the routes accept', () => {
    expect(validId(shareId('payload-of-a-route'))).toBe(true);
  });
});

describe('readShare', () => {
  it('answers nothing rather than throwing when no store is configured', async () => {
    // the share page reads a record before it can dress itself, and it still has a page to serve
    await expect(readShare('abc1234567')).resolves.toBeNull();
  });
});

describe('validId', () => {
  it('accepts what the store hands out and nothing else', () => {
    expect(validId('abc1234567')).toBe(true);
    expect(validId('../../etc/passwd')).toBe(false);
    expect(validId('abc*')).toBe(false);
    expect(validId('')).toBe(false);
    expect(validId(null)).toBe(false);
  });
});

/** width and height read off the jpeg SOF marker */
function jpegSize(data: Buffer): { width: number; height: number } {
  let i = 2;
  while (i < data.length - 9) {
    if (data[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = data[i + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    i += 2 + data.readUInt16BE(i + 2);
  }
  throw new Error('no jpeg dimensions');
}
