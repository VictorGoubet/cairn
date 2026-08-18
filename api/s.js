/**
 * The page a short share link points at: `/s/<id>`.
 *
 * A crawler reads Open Graph tags out of the HTML and never runs javascript, so the tags have to
 * be in the document itself. The app is a static single page, so this function serves that same
 * page with the route's own title, description and thumbnail injected into its head; the browser
 * then loads the app as usual and reads the id from the path.
 */

import { readShare, validId } from './_kv.js';

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export default async function handler(request) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const record = validId(id) ? await readShare(id) : null;
  const title = record?.name ? `${record.name} · cairn` : 'cairn · itinéraire partagé';
  const description = record?.description || 'Itinéraire de randonnée partagé avec cairn';
  const image = validId(id) ? `${url.origin}/api/preview?id=${id}` : `${url.origin}/logo.png`;

  const page = await fetch(new URL('/index.html', url.origin)).then(
    res => (res.ok ? res.text() : null),
    () => null,
  );
  return new Response(sharePage(page, id, title, description, image), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // shared links get hit by every preview bot in the chat, let the edge answer them
      'cache-control': 'public, max-age=0, s-maxage=3600',
    },
  });
}

/**
 * The document served for a share link: the app's own page wearing this route's tags.
 *
 * @param {string | null} page the static index.html, or null when it could not be read.
 * @param {string | null} id share identifier, used by the fallback document to hand over to the app.
 * @param {string} title page and Open Graph title.
 * @param {string} description one line of stats.
 * @param {string} image absolute URL of the thumbnail.
 * @returns {string}
 */
export function sharePage(page, id, title, description, image) {
  if (!page) return fallback(id, title, description, image);
  return page
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/<meta\s+name="description"[^>]*>/, '')
    // the static page carries the generic tags, this route's own must win
    .replace(/\s*<meta\s+(?:property|name)="(?:og|twitter):[^"]*"[^>]*>/g, '')
    .replace('</head>', `${tags(title, description, image)}</head>`);
}

/** when the static page cannot be read, a bare document that still previews and still opens */
function fallback(id, title, description, image) {
  const target = validId(id) ? `/#s=${id}` : '/';
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${esc(title)}</title>
${tags(title, description, image)}<meta http-equiv="refresh" content="0;url=${target}"></head>
<body><a href="${target}">cairn</a></body></html>`;
}

function tags(title, description, image) {
  return [
    `<meta name="description" content="${esc(description)}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="cairn">',
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:image" content="${esc(image)}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:image" content="${esc(image)}">`,
  ].join('\n');
}

/** @param {string} text */
function esc(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
