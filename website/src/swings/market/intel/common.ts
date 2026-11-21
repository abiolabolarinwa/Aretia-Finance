/**
 * Shared parts of the Aretia market intelligence engine (AMMI, ARF, ADV): the pool record every calculation reads, the rules for which tokens
 * and pools count, and the small statistics the formulas use. Pure: no network, no clock (callers pass `now`). The three calculations live in
 * ammi.ts, arf.ts and adv.ts; docs/market-intelligence.md states every formula and assumption.
 */
import type { MarketRow } from '../types.js';
import { WINDOW_MS, type LiveWindow } from '../liveFields.js';

export type Window = LiveWindow;
export const WINDOWS: readonly Window[] = ['m5', 'h1', 'h6', 'h24'];

/** Version of the methodology. A stored snapshot carries it, so an old figure is never read with a newer formula. */
export const METHOD_VERSION = 1;

export interface IntelConfig {
  /** A return within +/- this many percent is "neutral". */
  neutralPct: number;
  /** A pool below this liquidity does not count. */
  minLiquidityUsd: number;
  /** A pool whose 24-hour volume is more than this many times its liquidity is wash trading or a broken price. */
  maxVolumeToLiquidity: number;
  /** A pool with at least this many transactions in 24 hours but at most `washMaxTraders` accounts is repetitive trading. */
  washMinTxns: number;
  washMaxTraders: number;
  /** An account that turns a pool's whole liquidity over more than this many times in a day (volume / accounts / liquidity) is not trading, it is looping. */
  maxTurnoverPerTrader: number;
  /** A pool with at least this many transactions in 24 hours whose accounts average at least `loopTradesPerTrader` trades each is a bot looping it, however many accounts there are. */
  loopMinTxns: number;
  loopTradesPerTrader: number;
  /** Fewest eligible tokens for which a breadth figure or an index is shown. */
  minEligible: number;
  /** Trade size, in dollars, the depth measure asks about. */
  depthTradeUsd: number;
  /** Price impact at which a pool's depth score reaches zero (a fraction: 0.05 is 5%). */
  depthZeroImpact: number;
}

export const DEFAULT_CONFIG: IntelConfig = {
  neutralPct: 0.5,
  minLiquidityUsd: 1_000,
  maxVolumeToLiquidity: 100,
  washMinTxns: 20,
  washMaxTraders: 10,
  maxTurnoverPerTrader: 5,
  loopMinTxns: 100,
  loopTradesPerTrader: 40,
  minEligible: 20,
  depthTradeUsd: 1_000,
  depthZeroImpact: 0.05,
};

/** One pool as the engine reads it. Percent changes, dollar values; null means "not known", never zero. */
export interface IntelPool {
  /** `chain:pool`, unique per pool: the same pool listed twice is counted once. */
  key: string;
  chain: string;
  /** `chain:base token address`: two pools of one token share it. */
  token: string;
  venue: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  ageMs: number | null;
  change: Record<Window, number | null>;
  volumeUsd: Record<Window, number | null>;
  txns24h: number | null;
  /** The pool's transaction count covers only its newest trades, so it is a floor. */
  txnsCapped: boolean;
  traders24h: number | null;
}

const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A Markets row as an engine pool. Rows without a pool or a token address cannot be told apart, so they give null. */
export function fromMarketRow(r: MarketRow): IntelPool | null {
  if (!r.pool || !r.address) return null;
  const lower = r.chain !== 'solana';
  const win = (src: Partial<Record<Window, number | null>> | undefined): Record<Window, number | null> => ({ m5: fin(src?.m5), h1: fin(src?.h1), h6: fin(src?.h6), h24: fin(src?.h24) });
  const volume = win(r.volumeUsd);
  if (volume.h24 === null) volume.h24 = fin(r.volume24hUsd);
  return {
    key: `${r.chain}:${lower ? r.pool.toLowerCase() : r.pool}`,
    chain: r.chain,
    token: `${r.chain}:${lower ? r.address.toLowerCase() : r.address}`,
    venue: r.venue?.trim() || null,
    priceUsd: fin(r.priceUsd),
    liquidityUsd: fin(r.liquidityUsd),
    ageMs: fin(r.ageMs),
    change: win(r.change),
    volumeUsd: volume,
    txns24h: fin(r.txns24h),
    txnsCapped: r.txnsCapped === true,
    traders24h: fin(r.traders24h),
  };
}

export type Exclusion = 'no-price' | 'no-change' | 'low-liquidity' | 'new-listing' | 'duplicate' | 'suspicious' | 'no-volume' | 'no-venue';

export interface Screened {
  eligible: IntelPool[];
  excluded: Partial<Record<Exclusion, number>>;
  /** How many distinct pools were looked at. */
  considered: number;
}

export const bump = (m: Partial<Record<Exclusion, number>>, k: Exclusion): void => void (m[k] = (m[k] ?? 0) + 1);

/**
 * Wash trading or a broken price: far more volume than the pool could hold, many trades from a handful of accounts, accounts that trade the pool
 * dozens of times a day each (a bot, whatever the number of accounts), or a few accounts each
 * turning the pool's whole liquidity over several times a day. (A day-old token with $2.7M of liquidity that did $220M from five accounts passed
 * the first two rules and is what the third is for. Real tokens spread their volume over hundreds of accounts.)
 */
export function suspicious(p: IntelPool, c: IntelConfig = DEFAULT_CONFIG): boolean {
  const liq = p.liquidityUsd ?? 0;
  const v = p.volumeUsd.h24 ?? 0;
  if (liq > 0 && v > c.maxVolumeToLiquidity * liq) return true;
  if ((p.txns24h ?? 0) >= c.washMinTxns && p.traders24h !== null && p.traders24h <= c.washMaxTraders) return true;
  // Eleven accounts with 120 trades each pass the rule above by one account and are plainly a bot: people do not trade a token a hundred times a day.
  if ((p.txns24h ?? 0) >= c.loopMinTxns && p.traders24h !== null && p.traders24h >= 1 && (p.txns24h ?? 0) / p.traders24h >= c.loopTradesPerTrader) return true;
  return liq > 0 && p.traders24h !== null && p.traders24h >= 1 && v / p.traders24h > c.maxTurnoverPerTrader * liq;
}

/**
 * The tokens that count for a return over `window`: a valid price, a valid change over that very window (so a pool that did not trade in it is
 * out), enough liquidity, older than the window (a token younger than it has no price from before it opened, and must not read as "rising"
 * because its first price is above zero), not suspicious, and one pool per token (the most liquid; the same token on two pools or two
 * venues is one token).
 */
export function screenTokens(pools: readonly IntelPool[], window: Window, c: IntelConfig = DEFAULT_CONFIG): Screened {
  const excluded: Partial<Record<Exclusion, number>> = {};
  const best = new Map<string, IntelPool>();
  const seen = new Set<string>();
  const minAge = Math.max(WINDOW_MS[window], 15 * 60_000);
  let considered = 0;
  for (const p of pools) {
    if (seen.has(p.key)) continue; // the same pool twice
    seen.add(p.key);
    considered++;
    if (p.priceUsd === null || !(p.priceUsd > 0)) {
      bump(excluded, 'no-price');
      continue;
    }
    const ch = p.change[window];
    if (ch === null || !(1 + ch / 100 > 0)) {
      bump(excluded, 'no-change');
      continue;
    }
    if (p.liquidityUsd === null || p.liquidityUsd < c.minLiquidityUsd) {
      bump(excluded, 'low-liquidity');
      continue;
    }
    if (p.ageMs === null || p.ageMs < minAge) {
      bump(excluded, 'new-listing');
      continue;
    }
    if (suspicious(p, c)) {
      bump(excluded, 'suspicious');
      continue;
    }
    const cur = best.get(p.token);
    if (!cur) best.set(p.token, p);
    else {
      bump(excluded, 'duplicate');
      if ((p.liquidityUsd ?? 0) > (cur.liquidityUsd ?? 0)) best.set(p.token, p);
    }
  }
  return { eligible: [...best.values()], excluded, considered };
}

// ------------------------------------------------------------------ statistics

export const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));
export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/** The q-quantile (0 to 1) by linear interpolation; NaN for no values. */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/** Values pulled in to the 2.5th and 97.5th percentile, so one extreme return cannot decide an average. Fewer than 20 values are left alone. */
export function winsorize(values: readonly number[], lowQ = 0.025, highQ = 0.975): number[] {
  if (values.length < 20) return [...values];
  const lo = quantile(values, lowQ);
  const hi = quantile(values, highQ);
  return values.map((v) => clamp(v, lo, hi));
}

export function weightedMean(values: readonly number[], weights: readonly number[]): number | null {
  let sw = 0;
  let sv = 0;
  for (let i = 0; i < values.length; i++) {
    const w = weights[i]!;
    if (!(w > 0) || !Number.isFinite(values[i]!)) continue;
    sw += w;
    sv += w * values[i]!;
  }
  return sw > 0 ? sv / sw : null;
}

/** Relative strength index of a series of changes: the last `period` values. 50 when nothing moved; null with too few values. */
export function rsiOfChanges(changes: readonly number[], period = 14): number | null {
  if (changes.length < period) return null;
  const last = changes.slice(-period);
  let gain = 0;
  let loss = 0;
  for (const c of last) {
    if (c > 0) gain += c;
    else loss -= c;
  }
  if (gain === 0 && loss === 0) return 50;
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
