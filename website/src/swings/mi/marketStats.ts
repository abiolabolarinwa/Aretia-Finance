/**
 * The Markets page's stats bar: 24-hour volume and transactions across the pools Aretia's index holds, and the latest block it has seen on
 * each network. Pure: it turns the rows the endpoint reads (api/_swingsMarketIndex.ts, `src=stats`) into the numbers the page shows.
 *
 * What the numbers are, in words the page repeats: the total is the sum over the pools the index follows and has a stored trade for in the
 * last 24 hours with $1,000+ of liquidity that pass the wash-trading checks (the same pools as the busiest-venues card), not the whole market of a network. A dash means the index has nothing, never zero.
 */
import { isMiChain, MI_CHAINS, type MiChain } from './chains.js';
import { screenVenuePools } from '../market/intel/adv.js';
import type { IntelPool } from '../market/intel/common.js';
import type { AdapterHealth } from './types.js';

export interface ChainStats {
  volume24hUsd: number;
  txns24h: number;
  /** Pools with a stored trade in the last 24 hours that were counted. */
  pools: number;
  /** Pools left out because their volume is over 100 times their liquidity, and the volume they claimed. */
  excludedPools: number;
  excludedVolume24hUsd: number;
  /** Counted pools that traded more than the stored window holds, so the totals are a floor. */
  cappedPools: number;
  /** The newest block (Solana: slot) the index has seen on this network, and when it saw it (ms). Null when no adapter of the network has run. */
  latestBlock: number | null;
  blockSeenAt: number | null;
}

export interface MarketStats {
  asOf: number;
  total: { volume24hUsd: number; txns24h: number; pools: number; excludedPools: number; excludedVolume24hUsd: number; cappedPools: number };
  chains: Partial<Record<MiChain, ChainStats>>;
}

/**
 * The stats bar's numbers from the same pools and the same checks as the market intelligence engine's venue volume (src/swings/market/intel/):
 * a pool counts when it has a day's volume, a venue, at least $1,000 of liquidity and passes the wash-trading checks. A pool that fails those
 * is left out and its volume reported, so the bar's total and the venues' total are one figure for one set of pools.
 */
export function buildStats(pools: readonly IntelPool[], health: readonly Pick<AdapterHealth, 'chain' | 'head' | 'safeHead' | 'lastSuccessAt' | 'lastRunAt'>[], now: number): MarketStats {
  const chains: Partial<Record<MiChain, ChainStats>> = {};
  const at = (c: MiChain): ChainStats => (chains[c] ??= { volume24hUsd: 0, txns24h: 0, pools: 0, excludedPools: 0, excludedVolume24hUsd: 0, cappedPools: 0, latestBlock: null, blockSeenAt: null });
  const byChain = new Map<MiChain, IntelPool[]>();
  for (const p of pools) if (isMiChain(p.chain)) byChain.set(p.chain, [...(byChain.get(p.chain) ?? []), p]);
  for (const [chain, list] of byChain) {
    const s = screenVenuePools(list);
    if (s.eligible.length === 0 && s.excludedVolume === 0) continue;
    const c = at(chain);
    for (const p of s.eligible) {
      c.volume24hUsd += p.volumeUsd.h24 ?? 0;
      c.txns24h += p.txns24h ?? 0;
      c.pools += 1;
      if (p.txnsCapped) c.cappedPools += 1;
    }
    c.excludedPools = s.excluded.suspicious ?? 0;
    c.excludedVolume24hUsd = s.excludedVolume;
  }
  for (const h of health) {
    if (!isMiChain(h.chain)) continue;
    const block = h.head ?? h.safeHead;
    if (block === null || !Number.isFinite(block) || block <= 0) continue;
    const c = at(h.chain);
    if (c.latestBlock === null || block > c.latestBlock) {
      c.latestBlock = block;
      c.blockSeenAt = h.lastSuccessAt ?? h.lastRunAt;
    }
  }
  const total = { volume24hUsd: 0, txns24h: 0, pools: 0, excludedPools: 0, excludedVolume24hUsd: 0, cappedPools: 0 };
  for (const c of MI_CHAINS) {
    const s = chains[c];
    if (!s) continue;
    total.volume24hUsd += s.volume24hUsd;
    total.txns24h += s.txns24h;
    total.pools += s.pools;
    total.excludedPools += s.excludedPools;
    total.excludedVolume24hUsd += s.excludedVolume24hUsd;
    total.cappedPools += s.cappedPools;
  }
  return { asOf: now, total, chains };
}
