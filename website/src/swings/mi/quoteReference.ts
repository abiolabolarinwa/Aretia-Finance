/**
 * What one whole quote token (WETH, WBNB, WSOL, WMATIC...) was worth in dollars at the time of each candle, read from the Market
 * Indexer's OWN stored trades of that token's most liquid pool against a dollar stablecoin. Nothing here is invented: a candle
 * with no reference trade shortly before it gets no dollar candle, and the answer says which pool the figures came from and when
 * the newest reference trade happened, so the chart can show it.
 */
import type { MiPool, MiTrade } from './types.js';
import type { MiStore } from './store.js';
import { chainConfig, NATIVE_ADDRESS, type MiChain } from './chains.js';
import { toNumber } from './math.js';
import { WRAPPED_NATIVE } from '../dex/entries.js';

/** A reference trade older than this (before the end of a candle) is too old to price it. */
export const MAX_REFERENCE_AGE_S = 2 * 3600;

export interface QuoteReference {
  /** The pool the dollar prices came from. */
  pool: string;
  /** Pool name for display, such as "WETH / USDC". */
  label: string;
  /** Reference trades, oldest first: [unix seconds, dollars per whole quote token]. */
  points: [number, number][];
  /** Dollar price of the newest reference trade used, and when it happened. */
  latest: { price: number; at: number };
}

/** The reference pool for a quote token: the most liquid followed pool pairing it with a dollar stablecoin. Null when there is none. */
export async function findReferencePool(store: MiStore, chain: MiChain, quote: string): Promise<{ pool: MiPool; inverted: boolean; label: string } | null> {
  const cfg = chainConfig(chain);
  const asked = quote === NATIVE_ADDRESS ? (chain === 'solana' ? quote : (WRAPPED_NATIVE as Record<string, string | undefined>)[chain] ?? quote) : quote;
  const found = await store.listPools({ chain, tokenKey: `${chain}:${asked}`, sort: 'liquidity', limit: 25 });
  const symbolOf = (a: string): string => cfg.quoteTokens.find((x) => x.address === a)?.symbol ?? 'USD';
  for (const p of found.pools) {
    if (p.paused) continue;
    const isUsd = (a: string): boolean => cfg.quoteTokens.some((x) => x.address === a && x.role === 'usd');
    // The quote token is the pool's base and a dollar stablecoin its quote: the price is already dollars per token.
    if (p.base === asked && isUsd(p.quote)) return { pool: p, inverted: false, label: `${symbolOf(p.base)} / ${symbolOf(p.quote)}` };
    // Priced the other way round (stablecoin as base, the token as quote): dollars per token is one over the price.
    if (p.quote === asked && isUsd(p.base)) return { pool: p, inverted: true, label: `${symbolOf(p.quote)} / ${symbolOf(p.base)}` };
  }
  return null;
}

/** Reference trades to price candles between `fromSec` and `toSec`, with the last trade before the window as the starting point. */
export async function loadQuoteReference(store: MiStore, chain: MiChain, quote: string, fromSec: number, toSec: number): Promise<QuoteReference | null> {
  const ref = await findReferencePool(store, chain, quote);
  if (!ref) return null;
  const start = fromSec - MAX_REFERENCE_AGE_S;
  const [seed, inside] = await Promise.all([store.lastTradeBefore(chain, ref.pool.address, start), store.tradesSince(chain, ref.pool.address, start, 10_000)]);
  const trades: MiTrade[] = [...(seed ? [seed] : []), ...inside].filter((t) => t.time < toSec);
  const points: [number, number][] = [];
  for (const t of trades) {
    const p = toNumber(t.price);
    const usd = ref.inverted ? 1 / p : p;
    if (Number.isFinite(usd) && usd > 0) points.push([t.time, usd]);
  }
  points.sort((a, b) => a[0] - b[0]);
  const last = points[points.length - 1];
  if (!last) return null;
  return { pool: ref.pool.address, label: ref.label, points, latest: { price: last[1], at: last[0] } };
}

/** The reference price in force at `timeSec`: the newest reference trade at or before it, if not older than the maximum age. */
export function referencePriceAt(points: readonly [number, number][], timeSec: number): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]![0] <= timeSec) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const hit = found >= 0 ? points[found]! : null;
  return hit && timeSec - hit[0] <= MAX_REFERENCE_AGE_S ? hit[1] : null;
}

type Row = [number, number, number, number, number, number];

/** Candles priced in a quote token, turned into dollars with the reference price at the END of each candle. Candles with no reference price are dropped. */
export function convertRowsToUsd(rows: readonly Row[], stepSec: number, points: readonly [number, number][]): Row[] {
  const out: Row[] = [];
  for (const [t, o, h, l, c, v] of rows) {
    const u = referencePriceAt(points, t + stepSec - 1);
    if (u === null) continue;
    out.push([t, o * u, h * u, l * u, c * u, v * u]);
  }
  return out;
}
