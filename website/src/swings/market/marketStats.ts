/**
 * The Markets page's side of the stats bar: the request for the index's numbers, and the words and figures the three cells show. Pure apart
 * from the one `fetch`. The numbers come from Aretia's own index (see mi/marketStats.ts); the page says so in each cell's hover text.
 */
import type { ChainId } from '../core/types.js';

export interface ChainStatsDto {
  volume24hUsd: number;
  txns24h: number;
  pools: number;
  excludedPools?: number;
  excludedVolume24hUsd?: number;
  cappedPools?: number;
  latestBlock: number | null;
  blockSeenAt: number | null;
}
export interface MarketStatsDto {
  asOf: number;
  total: { volume24hUsd: number; txns24h: number; pools: number; excludedPools?: number; excludedVolume24hUsd?: number; cappedPools?: number };
  chains: Partial<Record<string, ChainStatsDto>>;
}

export const STATS_URL = '/api/swings-market?src=stats';

/** The network names the bar uses for the latest-block cell when it lists every network. */
export const CHAIN_SHORT: Readonly<Record<string, string>> = { solana: 'SOL', ethereum: 'ETH', bnb: 'BNB', base: 'Base', polygon: 'Polygon', robinhood: 'Robinhood' };

/** The numbers for the chosen network, or for all networks together. Null when the index has none. */
export function statsFor(s: MarketStatsDto | null, chain: '' | ChainId): { volume24hUsd: number; txns24h: number; pools: number; excludedPools: number; excludedVolume24hUsd: number; cappedPools: number } | null {
  if (!s) return null;
  const t = chain === '' ? s.total : s.chains[chain];
  return t && t.pools > 0 ? { volume24hUsd: t.volume24hUsd, txns24h: t.txns24h, pools: t.pools, excludedPools: t.excludedPools ?? 0, excludedVolume24hUsd: t.excludedVolume24hUsd ?? 0, cappedPools: t.cappedPools ?? 0 } : null;
}

/** The latest blocks to show: the chosen network's one, or one per network (busiest first) when all are chosen. */
export function blocksFor(s: MarketStatsDto | null, chain: '' | ChainId): { chain: string; block: number; seenAt: number | null }[] {
  if (!s) return [];
  const list = (chain === '' ? Object.keys(s.chains) : [chain]).flatMap((c) => {
    const x = s.chains[c];
    return x && x.latestBlock !== null ? [{ chain: c, block: x.latestBlock, seenAt: x.blockSeenAt, vol: x.volume24hUsd }] : [];
  });
  return list.sort((a, b) => b.vol - a.vol).map(({ chain: c, block, seenAt }) => ({ chain: c, block, seenAt }));
}

/** "2s ago", "5 min ago", "3h ago"; empty when the time is unknown. */
export function agoText(seenAt: number | null, now: number): string {
  if (seenAt === null || !Number.isFinite(seenAt)) return '';
  const s = Math.max(0, Math.round((now - seenAt) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

/** The index's stats, or null when it is unreachable or answers nothing usable: a missing bar is never an error on the page. */
export async function fetchMarketStats(fetchImpl: typeof fetch = (...a) => fetch(...a), signal?: AbortSignal): Promise<MarketStatsDto | null> {
  try {
    const res = await fetchImpl(STATS_URL, { signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<MarketStatsDto> & { error?: unknown };
    if (body.error || typeof body.asOf !== 'number' || !body.total || typeof body.chains !== 'object' || body.chains === null) return null;
    return body as MarketStatsDto;
  } catch {
    return null;
  }
}
