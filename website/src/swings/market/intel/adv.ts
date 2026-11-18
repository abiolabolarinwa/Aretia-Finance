/**
 * ADV: the Aretia DEX volume engine. Ranks venues by the dollar volume of the pools that pass the same checks as everything else, with each
 * pool counted once, and reports each venue's share of the total, its growth against the previous 24 hours (when a stored snapshot of that
 * time exists) and its swap count.
 *
 * What the volume is: the sum of each eligible pool's own 24-hour volume. A swap is one trade in one pool, and the index stores each once
 * (its key is the chain, the pool and the transaction, so a transaction seen twice is one row). A route through several pools counts in each
 * pool it touched: that is pool-level volume, not end-user volume, because the index reads pools, not whole transactions. The docs say so.
 */
import { DEFAULT_CONFIG, bump, suspicious, type Exclusion, type IntelConfig, type IntelPool } from './common.js';

export interface VenueRow {
  venue: string;
  volume24hUsd: number;
  /** Share of the eligible volume of all venues, 0 to 100. */
  share: number;
  /** Change against the previous 24 hours, in percent; null when there is no stored figure for that time (never zero in its place). */
  growth: number | null;
  swaps24h: number;
  /** The swap count is a floor: a pool traded more than the index keeps. */
  swapsCapped: boolean;
  pools: number;
}

export interface AdvResult {
  venues: VenueRow[];
  /** All eligible volume, over all venues (not only the ones returned). */
  totalVolume24hUsd: number;
  venueCount: number;
  eligiblePools: number;
  considered: number;
  excluded: Partial<Record<Exclusion, number>>;
  /** Volume the checks left out: pools with far more volume than liquidity, or many trades from almost no accounts. */
  excludedVolume24hUsd: number;
}

/** The pools that count for venue volume, each once. */
export function screenVenuePools(pools: readonly IntelPool[], c: IntelConfig = DEFAULT_CONFIG): { eligible: IntelPool[]; excluded: Partial<Record<Exclusion, number>>; considered: number; excludedVolume: number } {
  const excluded: Partial<Record<Exclusion, number>> = {};
  const seen = new Set<string>();
  const eligible: IntelPool[] = [];
  let considered = 0;
  let excludedVolume = 0;
  for (const p of pools) {
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    considered++;
    const v = p.volumeUsd.h24;
    if (v === null || !(v > 0)) {
      bump(excluded, 'no-volume');
      continue;
    }
    if (!p.venue) {
      bump(excluded, 'no-venue');
      continue;
    }
    if (p.liquidityUsd === null || p.liquidityUsd < c.minLiquidityUsd) {
      bump(excluded, 'low-liquidity');
      continue;
    }
    if (suspicious(p, c)) {
      bump(excluded, 'suspicious');
      excludedVolume += v;
      continue;
    }
    eligible.push(p);
  }
  return { eligible, excluded, considered, excludedVolume };
}

/** `previous` is each venue's 24-hour volume in the 24 hours before now (from a stored snapshot), by venue name; absent when there is none. */
export function adv(pools: readonly IntelPool[], previous: ReadonlyMap<string, number> | null, top = 4, c: IntelConfig = DEFAULT_CONFIG): AdvResult {
  const s = screenVenuePools(pools, c);
  const by = new Map<string, { v: number; swaps: number; capped: boolean; pools: number }>();
  let total = 0;
  for (const p of s.eligible) {
    const v = p.volumeUsd.h24!;
    total += v;
    const cur = by.get(p.venue!) ?? { v: 0, swaps: 0, capped: false, pools: 0 };
    cur.v += v;
    cur.swaps += p.txns24h ?? 0;
    cur.capped ||= p.txnsCapped;
    cur.pools++;
    by.set(p.venue!, cur);
  }
  const rows: VenueRow[] = [...by.entries()]
    .map(([venue, x]) => {
      const before = previous?.get(venue);
      return {
        venue,
        volume24hUsd: x.v,
        share: total > 0 ? (100 * x.v) / total : 0,
        growth: before !== undefined && before > 0 ? (x.v / before - 1) * 100 : null,
        swaps24h: x.swaps,
        swapsCapped: x.capped,
        pools: x.pools,
      };
    })
    .sort((a, b) => b.volume24hUsd - a.volume24hUsd);
  return { venues: rows.slice(0, top), totalVolume24hUsd: total, venueCount: rows.length, eligiblePools: s.eligible.length, considered: s.considered, excluded: s.excluded, excludedVolume24hUsd: s.excludedVolume };
}
