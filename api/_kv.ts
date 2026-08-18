/**
 * The only server-side state cairn keeps: share records, in a Redis-compatible key-value store
 * reached over HTTP (Upstash, which Vercel offers on a free tier).
 *
 * Nothing here is required for the app to work. When no store is configured the share endpoints
 * answer 503 and the client falls back to the self-contained link that carries the whole route
 * in its fragment, which is how cairn shared routes before short links existed.
 */

/** a shared link stays alive a year, long enough for a season of hikes */
const TTL_S = 60 * 60 * 24 * 365;

export interface ShareRecord {
  /** the route, in the same encoding the #r= fragment uses */
  payload: string;
  name: string;
  /** one line of stats, shown as the link description */
  description: string;
  /** base64 jpeg shown as the link thumbnail */
  image: string;
}

export function kvConfigured(): boolean {
  return Boolean(endpoint() && token());
}

/**
 * Reads a share record.
 *
 * Args:
 *   id: short identifier from the link.
 *
 * Returns:
 *   The record, or null when it never existed or expired.
 */
export async function readShare(id: string): Promise<ShareRecord | null> {
  const res = await fetch(`${endpoint()}/get/${key(id)}`, { headers: { Authorization: `Bearer ${token()}` } });
  if (!res.ok) return null;
  const { result } = (await res.json()) as { result: string | null };
  if (!result) return null;
  try {
    return JSON.parse(result) as ShareRecord;
  } catch {
    return null;
  }
}

/**
 * Stores a share record under a fresh identifier.
 *
 * Args:
 *   record: route, name, description and thumbnail.
 *
 * Returns:
 *   The identifier to put in the link, or null when the store refused.
 */
export async function writeShare(record: ShareRecord): Promise<string | null> {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  const res = await fetch(`${endpoint()}/set/${key(id)}?EX=${TTL_S}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}` },
    body: JSON.stringify(record),
  });
  return res.ok ? id : null;
}

/** an id from a URL indexes nothing else in the store, and only these characters ever appear */
export function validId(id: string | null): id is string {
  return typeof id === 'string' && /^[0-9a-f]{4,32}$/.test(id);
}

export function json(body: unknown, status = 200, cacheSeconds = 0): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
    },
  });
}

function endpoint(): string | undefined {
  return process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
}

function token(): string | undefined {
  return process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
}

function key(id: string): string {
  return `cairn:share:${id}`;
}
