/**
 * What "trending" means on Aretia's Solana lists: the tokens whose trading is speeding up, not simply the biggest.
 *
 * "Top" already ranks by value traded over the day. Trending used to be the same list at 24 hours, which tells a visitor nothing new. Here a
 * token's score is the value it traded over the chosen window, boosted by how much busier that window is than the token's own average pace
 * over the day:
 *
 *   pace    = value traded in the window / (value traded in 24 hours x the window's share of a day)
 *   score   = value traded x sqrt(min(pace, 25))      (only when pace is at least 1: a token slowing down is not trending)
 *
 * A pace of 3 means the window is three times as busy as the token's average. The boost is a square root and capped, so a tiny token with one
 * lucky trade cannot outrank a busy one, and a floor on the value traded (per window) keeps dust out altogether. For the 24-hour tab, which
 * has no shorter reference of its own, the pace is that of the last six hours against the day. It is a plain formula on the volumes the index
 * already holds, so anyone can recompute it. Nothing here predicts price.
 */
import type { MarketRow } from '../../market/types.js';

export type TrendWindow = 'm5' | 'h1' | 'h6' | 'h24';

/** How many hours each window covers. */
const HOURS: Record<TrendWindow, number> = { m5: 5 / 60, h1: 1, h6: 6, h24: 24 };
/** The least value (US dollars) a window must have traded for a token to be ranked in it. */
export const TREND_FLOOR_USD: Record<TrendWindow, number> = { m5: 200, h1: 1_000, h6: 3_000, h24: 10_000 };
/** The boost stops growing at this pace. */
export const MAX_PACE = 25;

/** The pace of a window against the day, or null when it cannot be worked out. */
export function paceOf(row: Pick<MarketRow, 'volumeUsd'>, window: TrendWindow): number | null {
  const day = row.volumeUsd?.h24 ?? null;
  const reference: TrendWindow = window === 'h24' ? 'h6' : window;
  const traded = row.volumeUsd?.[reference] ?? null;
  if (day === null || traded === null || day <= 0) return null;
  return traded / ((day * HOURS[reference]) / 24);
}

/** The trending score of a row in a window; 0 when it should not be ranked (below the floor, slowing down, or not enough numbers). */
export function trendingScore(row: Pick<MarketRow, 'volumeUsd'>, window: TrendWindow): number {
  const traded = row.volumeUsd?.[window] ?? null;
  if (traded === null || traded < TREND_FLOOR_USD[window]) return 0;
  const pace = paceOf(row, window);
  if (pace === null || pace < 1) return 0;
  return traded * Math.sqrt(Math.min(pace, MAX_PACE));
}
