/**
 * Network helpers with a deadline.
 *
 * Every service we call is free or volunteer-run, so a request can hang instead of failing.
 * Without a deadline the caller's promise never settles: a leg stays stuck in "computing",
 * its slot stays in the in-flight set, and the retry path can no longer relaunch it.
 */

const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
