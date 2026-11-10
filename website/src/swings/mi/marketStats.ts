/**
 * The Markets page's stats bar: 24-hour volume and transactions across the pools Aretia's index holds, and the latest block it has seen on
 * each network. Pure: it turns the rows the endpoint reads (api/_swingsMarketIndex.ts, `src=stats`) into the numbers the page shows.
 *
 * What the numbers are, in words the page repeats: the total is the sum over the pools the index follows and has a stored trade for in the
 * last 24 hours (liquidity $100+ and listed), not the whole market of a network. A dash means the index has nothing, never zero.
 */
import { isMiChain, MI_CHAINS, type MiChain } from './chains.js';
import type { AdapterHealth } from './types.js';

/** Pools below this liquidity are left out (the same floor as every Markets list). */
export const STATS_MIN_LIQUIDITY_USD = 100;

export interface StatsPoolRow {
  chain: string;
  vol24_usd: number | null;
  buys?: { h24?: number | null } | null;
  sells?: { h24?: number | null } | null;
}

export interface ChainStats {
  volume24hUsd: number;
  txns24h: number;
  /** Pools with a stored trade in the last 24 hours that were counted. */
  pools: number;
  /** The newest block (Solana: slot) the index has seen on this network, and when it saw it (ms). Null when no adapter of the network has run. */
  latestBlock: number | null;
  blockSeenAt: number | null;
}

export interface MarketStats {
  asOf: number;
  total: { volume24hUsd: number; txns24h: number; pools: number };
  chains: Partial<Record<MiChain, ChainStats>>;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

export function buildStats(pools: readonly StatsPoolRow[], health: readonly Pick<AdapterHealth, 'chain' | 'head' | 'safeHead' | 'lastSuccessAt' | 'lastRunAt'>[], now: number): MarketStats {
  const chains: Partial<Record<MiChain, ChainStats>> = {};
  const at = (c: MiChain): ChainStats => (chains[c] ??= { volume24hUsd: 0, txns24h: 0, pools: 0, latestBlock: null, blockSeenAt: null });
  for (const p of pools) {
    if (!isMiChain(p.chain)) continue;
    const vol = num(p.vol24_usd);
    if (vol === 0) continue;
    const c = at(p.chain);
    c.volume24hUsd += vol;
    c.txns24h += num(p.buys?.h24) + num(p.sells?.h24);
    c.pools += 1;
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
  const total = { volume24hUsd: 0, txns24h: 0, pools: 0 };
  for (const c of MI_CHAINS) {
    const s = chains[c];
    if (!s) continue;
    total.volume24hUsd += s.volume24hUsd;
    total.txns24h += s.txns24h;
    total.pools += s.pools;
  }
  return { asOf: now, total, chains };
}
