/**
 * The thumbnail a chat app or a social network shows for a shared link: the very tile the
 * browser rendered when the link was created, stored alongside the route.
 */

import { json, kvConfigured, readShare, validId } from './_kv.js';

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function GET(request) {
  if (!kvConfigured()) return json({ error: 'no store configured' }, 503);
  const id = new URL(request.url).searchParams.get('id');
  if (!validId(id)) return json({ error: 'bad id' }, 400);

  const record = await readShare(id);
  if (!record?.image) return json({ error: 'no preview' }, 404);

  return new Response(Buffer.from(record.image, 'base64'), {
    headers: {
      'content-type': 'image/jpeg',
      // crawlers refetch previews often and the image never changes
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}
