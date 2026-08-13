/**
 * Product events, sent to the Umami script loaded from `index.html`.
 *
 * The helper exists so call sites stay one line and so a missing script (development, an ad
 * blocker, an offline visitor) is a silent no-op: nothing here is allowed to break the planner.
 */

interface Umami {
  track(event: string, data?: Record<string, string | number | boolean>): void;
}

/**
 * Records that something worth counting happened.
 *
 * Args:
 *   event: short kebab-case name, the label shown in Umami.
 *   data: optional properties, kept small and non-identifying.
 */
export function track(event: string, data?: Record<string, string | number | boolean>): void {
  (window as { umami?: Umami }).umami?.track(event, data);
}
