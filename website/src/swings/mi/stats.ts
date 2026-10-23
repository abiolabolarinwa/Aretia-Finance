/**
 * Market numbers from stored trades. Pure. Prices stay decimal strings and amounts stay bigint until the last step, where
 * volumes are turned into display numbers. A window with no data gives null, never a made-up value.
 */
import { changeBps, parseRaw, toNumber, unitsToNumber } from './math.js';
import type { MiPool, MiTrade, PoolStats } from './types.js';

export const WINDOWS = { m5: 300, h1: 3_600, h6: 21_600, h24: 86_400 } as const;
type WindowKey = keyof typeof WINDOWS;

export interface UsdContext {
  /** What one whole quote token is worth in dollars: 1 for a dollar stablecoin, the chain's reference price for the wrapped native coin, otherwise null. */
  quoteUsd: number | null;
}

/**
 * @param trades   the pool's trades from `now - 24h` on, oldest first
 * @param prior    the last trade before `now - 24h`, if any
 * @param reserveQuoteRaw the pool's quote-side reserve (raw) for liquidity, if known
 */
export function computeStats(pool: Pick<MiPool, 'quoteDecimals'>, trades: readonly MiTrade[], prior: MiTrade | null, now: number, usd: UsdContext, reserveQuoteRaw: bigint | null): PoolStats | null {
  if (trades.length === 0 && !prior) return null;
  const nowSec = Math.floor(now / 1000);
  const last = trades.length ? trades[trades.length - 1]! : prior!;
  const price = last.price;
  const change = {} as PoolStats['change'];
  const vol: Record<WindowKey, bigint> = { m5: 0n, h1: 0n, h6: 0n, h24: 0n };
  const buys = { m5: 0, h1: 0, h6: 0, h24: 0 };
  const sells = { m5: 0, h1: 0, h6: 0, h24: 0 };
  let maxTrade = 0n;
  const makers = new Set<string>();

  for (const t of trades) {
    const q = parseRaw(t.quoteAmount) ?? 0n;
    if (q > maxTrade) maxTrade = q;
    makers.add(t.maker);
    for (const w of Object.keys(WINDOWS) as WindowKey[]) {
      if (t.time >= nowSec - WINDOWS[w]) {
        vol[w] += q;
        if (t.side === 'buy') buys[w]++;
        else sells[w]++;
      }
    }
  }
  const all = prior ? [prior, ...trades] : [...trades];
  for (const w of Object.keys(WINDOWS) as WindowKey[]) {
    const start = nowSec - WINDOWS[w];
    // The price the window opened at: the last trade at or before its start; for a pool younger than the window, its first trade.
    let ref: MiTrade | null = null;
    for (const t of all) if (t.time <= start) ref = t;
    if (!ref) ref = all[0] ?? null;
    // A single trade gives no change to speak of.
    change[w] = ref && ref.id !== last.id ? changeBps(ref.price, price) : null;
  }
  const total24 = vol.h24;
  const toQ = (v: bigint): number => unitsToNumber(v, pool.quoteDecimals);
  const volumeQuote = { m5: toQ(vol.m5), h1: toQ(vol.h1), h6: toQ(vol.h6), h24: toQ(vol.h24) };
  const u = usd.quoteUsd;
  const liquidityQuote = reserveQuoteRaw !== null ? toQ(reserveQuoteRaw) * 2 : null;
  return {
    asOf: now,
    price,
    priceUsd: u !== null ? toNumber(price) * u : null,
    change: { m5: change.m5 ?? null, h1: change.h1 ?? null, h6: change.h6 ?? null, h24: change.h24 ?? null },
    volumeQuote,
    volumeUsd: u !== null ? { m5: volumeQuote.m5 * u, h1: volumeQuote.h1 * u, h6: volumeQuote.h6 * u, h24: volumeQuote.h24 * u } : { m5: null, h1: null, h6: null, h24: null },
    buys,
    sells,
    maxTradeShare24h: total24 > 0n ? Number((maxTrade * 10_000n) / total24) / 10_000 : 0,
    makers24h: makers.size,
    // Both sides of a constant-product pool hold equal value, so liquidity is twice the quote reserve. For V3 pools the figure is
    // the quote-token balance the pool holds, which can overstate usable depth; it is labelled that way by the API.
    liquidityQuote,
    liquidityUsd: u !== null && liquidityQuote !== null ? liquidityQuote * u : null,
  };
}

export type CandleRow = [number, number, number, number, number, number];

/**
 * Candles from trades: one per period that had a trade (no gaps are filled with invented candles), oldest first. Open is the
 * first trade's price and close the last, ordered by time, block, then id, so the result does not depend on arrival order.
 * `quoteScale` converts the quote-denominated price (1 for quote units, 1 for a dollar quote).
 */
export function buildCandleRows(trades: readonly MiTrade[], seconds: number, quoteDecimals: number): CandleRow[] {
  if (!Number.isInteger(seconds) || seconds <= 0) return [];
  const ordered = [...trades].sort((a, b) => a.time - b.time || a.block - b.block || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: CandleRow[] = [];
  for (const t of ordered) {
    const p = toNumber(t.price);
    const v = unitsToNumber(parseRaw(t.quoteAmount) ?? 0n, quoteDecimals);
    if (!Number.isFinite(p) || p <= 0) continue;
    const bucket = Math.floor(t.time / seconds) * seconds;
    const c = out[out.length - 1];
    if (c && c[0] === bucket) {
      c[2] = Math.max(c[2], p);
      c[3] = Math.min(c[3], p);
      c[4] = p;
      c[5] += v;
    } else out.push([bucket, p, p, p, p, v]);
  }
  return out;
}

/**
 * Trending score with manipulation safeguards. A pool scores on how much real two-sided trading it has, discounted when the
 * numbers look manufactured: one trade dominating volume, few distinct accounts, one-sided flow, volume far above the
 * liquidity that would have to carry it, or a pool too young or too thin to judge. Returns null when the pool is not eligible.
 */
export interface TrendingInputs {
  stats: PoolStats;
  createdAt: number;
  now: number;
}
export const TRENDING = { minAgeMs: 10 * 60_000, minTrades1h: 5, minMakers24h: 3, minLiquidityUsd: 1_000, maxVolumeToLiquidity: 50 } as const;

export function trendingScore(i: TrendingInputs): number | null {
  const s = i.stats;
  if (i.now - i.createdAt < TRENDING.minAgeMs) return null;
  const trades1h = s.buys.h1 + s.sells.h1;
  if (trades1h < TRENDING.minTrades1h || s.makers24h < TRENDING.minMakers24h) return null;
  const liq = s.liquidityUsd ?? null;
  const vol = s.volumeUsd.h1 ?? null;
  // Without a dollar value neither liquidity nor volume can be compared across pools, so the pool is not ranked.
  if (liq === null || vol === null || liq < TRENDING.minLiquidityUsd) return null;
  let score = Math.log10(1 + vol) * Math.log10(1 + trades1h);
  const balance = Math.min(s.buys.h1, s.sells.h1) / Math.max(1, Math.max(s.buys.h1, s.sells.h1));
  score *= 0.4 + 0.6 * balance;
  if (s.maxTradeShare24h > 0.5) score *= 1 - Math.min(0.9, (s.maxTradeShare24h - 0.5) * 1.8);
  if (vol / liq > TRENDING.maxVolumeToLiquidity) score *= TRENDING.maxVolumeToLiquidity / (vol / liq);
  score *= Math.min(1, s.makers24h / 20);
  return Number.isFinite(score) && score > 0 ? score : null;
}
