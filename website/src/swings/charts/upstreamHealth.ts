/**
 * What this visit has learned about the data routes behind the chart, so the page stops doing things that cannot work.
 *
 * Aretia's own routes (/api/swings-ohlcv, /api/swings-trades) read GeckoTerminal for everyone. When GeckoTerminal refuses
 * them, every request used to wait for that refusal and then go to GeckoTerminal directly, which spends the visitor's own
 * small allowance (about 30 requests a minute). The Transactions table checks every second, so it could use the whole
 * allowance by itself and leave the chart with no candles. Two small tools stop that:
 *
 *  - a route that has just failed is skipped for a minute, and the page goes straight to its fallback;
 *  - direct reads of GeckoTerminal are rationed, so a table refreshing every second cannot starve the chart.
 *
 * State lives for the visit only (it is module memory, not storage).
 */

/** How long a failed route is left alone before it is tried again. */
export const ROUTE_DOWN_MS = 60_000;

const downUntil = new Map<string, number>();
const lastAt = new Map<string, number>();

export const routeIsDown = (route: string, now: number = Date.now()): boolean => (downUntil.get(route) ?? 0) > now;

export function markRouteDown(route: string, now: number = Date.now()): void {
  downUntil.set(route, now + ROUTE_DOWN_MS);
}

export function markRouteUp(route: string): void {
  downUntil.delete(route);
}

/** True at most once per `gapMs` for a key, and records the use when it says yes. Used to ration direct reads. */
export function allowEvery(key: string, gapMs: number, now: number = Date.now()): boolean {
  const last = lastAt.get(key);
  if (last !== undefined && now - last < gapMs) return false;
  lastAt.set(key, now);
  return true;
}

/** For tests, and for a page that wants a clean slate. */
export function resetUpstreamHealth(): void {
  downUntil.clear();
  lastAt.clear();
}
