import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readShare, validId } from '../../api/_kv.js';
import { sharePage } from '../../api/s.js';

/** the very page vercel serves, so the test breaks if its head stops matching the injection */
const INDEX = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

const TITLE = 'Tour du Queyras · cairn';
const DESCRIPTION = '130 km · +7 200 m · 42 h 10';
const IMAGE = 'https://cairn.test/api/preview?id=abc1234567';

describe('sharePage', () => {
  it('dresses the app page with the route own title, description and thumbnail', () => {
    const html = sharePage(INDEX, 'abc1234567', TITLE, DESCRIPTION, IMAGE);
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain(`<meta property="og:title" content="${TITLE}">`);
    expect(html).toContain(`<meta property="og:image" content="${IMAGE}">`);
    expect(html).toContain(`<meta property="og:description" content="${DESCRIPTION}">`);
    // and it is still the app: the bundle entry survives the rewrite
    expect(html).toContain('/src/main.tsx');
  });

  it('leaves exactly one of every tag a preview bot reads', () => {
    const html = sharePage(INDEX, 'abc1234567', TITLE, DESCRIPTION, IMAGE);
    for (const tag of ['property="og:title"', 'property="og:image"', 'property="og:description"', '<title>']) {
      expect(html.split(tag)).toHaveLength(2);
    }
    // the generic tags the static page carries must not compete with the route own
    expect(html).not.toContain('cairn · planificateur');
    expect(html).not.toContain('vercel.app/logo.png');
  });

  it('escapes a route name that would break the document', () => {
    const html = sharePage(INDEX, 'abc1234567', 'Col "haut" & <raide>', DESCRIPTION, IMAGE);
    expect(html).toContain('<meta property="og:title" content="Col &quot;haut&quot; &amp; &lt;raide&gt;">');
  });

  it('still previews and still opens when the app page cannot be read', () => {
    const html = sharePage(null, 'abc1234567', TITLE, DESCRIPTION, IMAGE);
    expect(html).toContain(`<meta property="og:image" content="${IMAGE}">`);
    expect(html).toContain('content="0;url=/#s=abc1234567"');
  });

  it('sends a visitor home rather than nowhere when the link has no usable id', () => {
    expect(sharePage(null, '../secret', TITLE, DESCRIPTION, IMAGE)).toContain('content="0;url=/"');
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
