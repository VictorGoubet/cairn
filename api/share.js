/**
 * Share records: POST one to get a short link, GET one to reopen the route it holds.
 *
 * The route travels exactly as it does in a #r= fragment, so a record is opaque here: the server
 * stores what the browser encoded and hands it back untouched.
 */

import { json, kvConfigured, readShare, validId, writeShare } from './_kv.js';

/** a very long route still fits, and a hostile body does not */
const MAX_PAYLOAD_CHARS = 300_000;
/** base64 of a jpeg preview, ~450 kB of image */
const MAX_IMAGE_CHARS = 600_000;

/**
 * Reopens a shared route.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function GET(request) {
  if (!kvConfigured()) return json({ error: 'no store configured' }, 503);
  const id = new URL(request.url).searchParams.get('id');
  if (!validId(id)) return json({ error: 'bad id' }, 400);
  const record = await readShare(id);
  if (!record) return json({ error: 'unknown link' }, 404);
  // a record never changes, so a browser that reopens the link can serve it from its own cache
  return json({ payload: record.payload, name: record.name }, 200, 3600);
}

/**
 * Stores a route and its preview, and hands back the id its short link carries.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function POST(request) {
  if (!kvConfigured()) return json({ error: 'no store configured' }, 503);
  const body = await request.json().catch(() => null);
  const payload = typeof body?.payload === 'string' ? body.payload : '';
  const image = typeof body?.image === 'string' ? body.image : '';
  if (!payload || payload.length > MAX_PAYLOAD_CHARS || image.length > MAX_IMAGE_CHARS) {
    return json({ error: 'bad payload' }, 400);
  }

  const id = await writeShare({
    payload,
    image,
    name: String(body?.name ?? '').slice(0, 120),
    description: String(body?.description ?? '').slice(0, 200),
  });
  return id ? json({ id }) : json({ error: 'store unavailable' }, 502);
}
