/**
 * The only server-side state cairn keeps: share records, in a Redis-compatible key-value store
 * reached over HTTP (Upstash, which Vercel offers on a free tier).
 *
 * Nothing here is required for the app to work. When no store is configured the share endpoints
 * answer 503 and the client falls back to the self-contained link that carries the whole route
 * in its fragment, which is how cairn shared routes before short links existed.
 *
 * These functions are plain javascript on purpose: vercel type-checks a typescript function with
 * the project's own typescript, and this repo runs a version its function builder cannot drive.
 */

/** a shared link stays alive a year, long enough for a season of hikes */
const TTL_S = 60 * 60 * 24 * 365;

/**
 * @typedef {object} ShareRecord
 * @property {string} payload the route, in the same encoding the #r= fragment uses
 * @property {string} name
 * @property {string} description one line of stats, shown as the link description
 * @property {string} image base64 jpeg shown as the link thumbnail
 */

/** @returns {boolean} */
export function kvConfigured() {
  return Boolean(endpoint() && token());
}

/**
 * Reads a share record.
 *
 * @param {string} id short identifier from the link.
 * @returns {Promise<ShareRecord | null>} the record, or null when it never existed or expired.
 */
export async function readShare(id) {
  const res = await fetch(`${endpoint()}/get/${key(id)}`, { headers: { Authorization: `Bearer ${token()}` } });
  if (!res.ok) return null;
  const { result } = await res.json();
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

/**
 * Stores a share record under a fresh identifier.
 *
 * @param {ShareRecord} record route, name, description and thumbnail.
 * @returns {Promise<string | null>} the identifier to put in the link, or null when the store refused.
 */
export async function writeShare(record) {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  const res = await fetch(`${endpoint()}/set/${key(id)}?EX=${TTL_S}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}` },
    body: JSON.stringify(record),
  });
  return res.ok ? id : null;
}

/**
 * An id from a URL indexes nothing else in the store, and only these characters ever appear.
 *
 * @param {string | null} id
 * @returns {boolean}
 */
export function validId(id) {
  return typeof id === 'string' && /^[0-9a-f]{4,32}$/.test(id);
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @param {number} [cacheSeconds]
 * @returns {Response}
 */
export function json(body, status = 200, cacheSeconds = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
    },
  });
}

function endpoint() {
  return process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
}

function token() {
  return process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
}

/** @param {string} id */
function key(id) {
  return `cairn:share:${id}`;
}
