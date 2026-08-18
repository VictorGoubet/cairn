/**
 * One door to the Overpass API for every overlay.
 *
 * The main instance allows two concurrent connections per IP and answers 429 beyond them, so
 * requests from the whole app funnel through a small queue here, with a pause between request
 * starts. A failing instance is retried once on a community mirror before giving up, and a
 * rate-limit refusal (406/429) opens a cooldown during which every call fails fast instead of
 * feeding the ban: both instances are volunteer-run, neither owes us uptime.
 */

import { fetchWithTimeout } from './http';

// in fallback order: the reference instance, its sibling server (a rate-limit ban is
// per-server), then the VK-hosted instance as the only independent one still open and CORS-ready
export const OVERPASS_PRIMARY = 'https://overpass-api.de/api/interpreter';

const ENDPOINTS = [
  OVERPASS_PRIMARY,
  'https://lz4.overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
/** what overpass-api.de grants a single IP */
const MAX_CONCURRENT = 2;
/** busy instances hold a query in queue well past our default deadline */
const TIMEOUT_MS = 30_000;
/** pause between request starts: a trickle reads as a user, a burst reads as a scraper */
const MIN_SPACING_MS = 300;
/** after the server said no (406/429), insisting only lengthens the ban */
const COOLDOWN_MS = 45_000;

let running = 0;
let lastStartAt = 0;
let cooledUntil = 0;
const waiting: (() => void)[] = [];

/**
 * Runs an Overpass QL query and returns its elements.
 *
 * Args:
 *   query: full QL text, `[out:json]` included.
 *
 * Raises:
 *   Error, immediately during the cooldown that follows a rate-limit refusal.
 */
export async function overpassQuery<T>(query: string): Promise<T[]> {
  if (Date.now() < cooledUntil) throw new Error('overpass cooling down');
  await acquire();
  try {
    const pause = lastStartAt + MIN_SPACING_MS - Date.now();
    if (pause > 0) await new Promise(resolve => setTimeout(resolve, pause));
    lastStartAt = Date.now();
    let lastError: unknown = new Error('overpass unreachable');
    let refused = false;
    for (const endpoint of ENDPOINTS) {
      try {
        // GET, not POST: the service worker can only serve cached GETs when offline
        const res = await fetchWithTimeout(overpassUrl(endpoint, query), undefined, TIMEOUT_MS);
        if (!res.ok) {
          refused ||= res.status === 406 || res.status === 429;
          throw new Error(`overpass ${res.status}`);
        }
        const data = await res.json();
        return (data.elements ?? []) as T[];
      } catch (err) {
        lastError = err;
      }
    }
    if (refused) cooledUntil = Date.now() + COOLDOWN_MS;
    throw lastError;
  } finally {
    release();
  }
}

/** the exact URL a query hits on `endpoint`, exported for the offline download */
export function overpassUrl(endpoint: string, query: string): string {
  return `${endpoint}?data=${encodeURIComponent(query)}`;
}

function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++;
    return Promise.resolve();
  }
  return new Promise(resolve => {
    waiting.push(() => {
      running++;
      resolve();
    });
  });
}

function release(): void {
  running--;
  waiting.shift()?.();
}
