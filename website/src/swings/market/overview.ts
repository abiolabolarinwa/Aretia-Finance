/**
 * The three short lists of the overview band at the top of the Markets list (top gainers, newly listed, trending) and the small price line of a
 * row, worked out from the list's own rows. The three cards above them (market mood, rising or falling, busiest venues) come from the market
 * intelligence engine (src/swings/market/intel/). Pure.
 */
import type { MarketRow } from './types.js';

const vol = (r: MarketRow): number => r.volumeUsd?.h24 ?? r.volume24hUsd ?? 0;

/** The biggest 24-hour risers, with at least a little traded value so one thin trade cannot top the list. */
export function topGainers(rows: readonly MarketRow[], n = 3, minVolumeUsd = 1_000): MarketRow[] {
  return rows
    .filter((r) => r.change.h24 !== null && r.change.h24 > 0 && vol(r) >= minVolumeUsd)
    .sort((a, b) => b.change.h24! - a.change.h24!)
    .slice(0, n);
}

/** The newest pools that have traded at all. */
export function newlyListed(rows: readonly MarketRow[], n = 3): MarketRow[] {
  return rows
    .filter((r) => r.ageMs !== null && r.ageMs >= 0 && (r.txns24h ?? 0) > 0)
    .sort((a, b) => a.ageMs! - b.ageMs!)
    .slice(0, n);
}

/** The busiest right now: most traded value in the last hour (the day's, where the hour is not known). */
export function trendingNow(rows: readonly MarketRow[], n = 3): MarketRow[] {
  const hot = (r: MarketRow): number => r.volumeUsd?.h1 ?? vol(r);
  return rows
    .filter((r) => hot(r) > 0)
    .sort((a, b) => hot(b) - hot(a))
    .slice(0, n);
}

/**
 * A small price line for a row, from the price now and its changes over 5 minutes, 1, 6 and 24 hours (so it is drawn from real figures, not
 * invented points). Each point is [position 0 (24 hours ago) to 1 (now), price]. Null when fewer than three points can be worked out.
 */
export function sparkPoints(r: Pick<MarketRow, 'priceUsd' | 'change'>): [number, number][] | null {
  const now = r.priceUsd;
  if (now === null || !(now > 0)) return null;
  const pts: [number, number][] = [];
  for (const [minutes, change] of [[1440, r.change.h24], [360, r.change.h6], [60, r.change.h1], [5, r.change.m5]] as [number, number | null][]) {
    if (change === null || !Number.isFinite(change) || 1 + change / 100 <= 0) continue;
    pts.push([(1440 - minutes) / 1440, now / (1 + change / 100)]);
  }
  pts.push([1, now]);
  return pts.length >= 3 ? pts : null;
}
