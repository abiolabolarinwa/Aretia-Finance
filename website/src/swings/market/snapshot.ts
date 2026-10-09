/**
 * Aretia's own copy of a token's market numbers. The discovery job already reads GeckoTerminal's pool lists on a server
 * every few minutes; it now keeps what they say (price, value, trades, volume, changes) in the token registry, so Find
 * Tokens reads Aretia's database instead of every visitor's browser asking DexScreener for 500 tokens.
 * A snapshot is dated. The page shows a fresh one as is and asks the outside source only for tokens whose snapshot is old.
 */
import { GECKO_NETWORK } from '../charts/pool.js';
import type { ChainId, TokenMarket, TokenRecord } from '../core/types.js';
import { LOCK_MIN_PCT } from './lock.js';
import type { MarketRow } from './types.js';

/** A snapshot older than this is treated as missing by the page. */
export const SNAPSHOT_FRESH_MS = 30 * 60_000;

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/** Reads the pool attributes GeckoTerminal gives for a pool into a dated snapshot. Pure. Null when there is no price at all. */
export function marketFromAttributes(a: unknown, pool: string, now: number): TokenMarket | null {
  const o = (a ?? {}) as Record<string, unknown>;
  const win = (v: unknown, k: string): number | null => num(((v ?? {}) as Record<string, unknown>)[k]);
  const price = num(o.base_token_price_usd);
  if (price === null || price <= 0) return null;
  const tx = ((o.transactions ?? {}) as Record<string, { buys?: number; sells?: number } | undefined>).h24;
  return {
    at: now,
    pool,
    priceUsd: price,
    capUsd: num(o.market_cap_usd) ?? num(o.fdv_usd),
    txns24h: typeof tx?.buys === 'number' && typeof tx?.sells === 'number' ? tx.buys + tx.sells : null,
    volume24hUsd: win(o.volume_usd, 'h24'),
    change: { m5: win(o.price_change_percentage, 'm5'), h1: win(o.price_change_percentage, 'h1'), h6: win(o.price_change_percentage, 'h6'), h24: win(o.price_change_percentage, 'h24') },
    liquidityUsd: num(o.reserve_in_usd),
  };
}

export const isFresh = (m: TokenMarket | null | undefined, now: number): m is TokenMarket => !!m && now - m.at >= 0 && now - m.at < SNAPSHOT_FRESH_MS;

/** A market snapshot of a registry token as table-row numbers. Pure. */
export function rowNumbers(m: TokenMarket, firstPoolAt: number | null, now: number): Pick<MarketRow, 'pool' | 'priceUsd' | 'capUsd' | 'txns24h' | 'volume24hUsd' | 'change' | 'liquidityUsd' | 'ageMs' | 'lockedPct'> {
  return { pool: m.pool, priceUsd: m.priceUsd, capUsd: m.capUsd, txns24h: m.txns24h, volume24hUsd: m.volume24hUsd, change: m.change, liquidityUsd: m.liquidityUsd, lockedPct: m.lock && m.lock.pct >= LOCK_MIN_PCT ? m.lock.pct : null, ageMs: firstPoolAt === null ? null : Math.max(0, now - firstPoolAt) };
}

export interface RefreshResult {
  asked: number;
  updated: number;
  error: string | null;
}

/** One GeckoTerminal request for up to 30 pools of one network. Keys are lower-cased pool addresses. A failure is returned, not thrown. */
export async function fetchPoolMarkets(chain: ChainId, pools: readonly string[], fetchImpl: typeof fetch, now: number): Promise<{ markets: Map<string, TokenMarket>; error: string | null }> {
  const markets = new Map<string, TokenMarket>();
  const list = [...new Set(pools.map((p) => p.toLowerCase()))].slice(0, 30);
  if (list.length === 0) return { markets, error: null };
  try {
    const res = await fetchImpl(`https://api.geckoterminal.com/api/v2/networks/${GECKO_NETWORK[chain]}/pools/multi/${list.join(',')}?include=base_token`, { headers: { accept: 'application/json' } });
    if (!res.ok) return { markets, error: `GeckoTerminal answered ${res.status} for ${chain}.` };
    const body = (await res.json()) as { data?: { attributes?: { address?: string } }[] };
    for (const p of body.data ?? []) {
      const pool = p.attributes?.address;
      const m = pool ? marketFromAttributes(p.attributes, pool, now) : null;
      if (pool && m) markets.set(pool.toLowerCase(), m);
    }
    return { markets, error: null };
  } catch (e) {
    return { markets, error: e instanceof Error ? e.message : 'The refresh failed.' };
  }
}

/**
 * Refreshes the snapshots of the stalest tokens on one network: one request for up to 30 pools.
 * Returns what changed; a failure is reported, not thrown, so one busy network does not stop the others.
 */
export async function refreshSnapshots(
  chain: ChainId,
  records: readonly TokenRecord[],
  save: (r: TokenRecord, m: TokenMarket) => Promise<void>,
  fetchImpl: typeof fetch,
  now: number,
): Promise<RefreshResult> {
  const withPool = records.filter((r) => r.pools[0]?.address).slice(0, 30);
  if (withPool.length === 0) return { asked: 0, updated: 0, error: null };
  const byPool = new Map(withPool.map((r) => [r.pools[0]!.address.toLowerCase(), r]));
  const { markets, error } = await fetchPoolMarkets(chain, [...byPool.keys()], fetchImpl, now);
  let updated = 0;
  for (const [pool, m] of markets) {
    const rec = byPool.get(pool);
    if (rec) {
      await save(rec, m);
      updated++;
    }
  }
  return { asked: withPool.length, updated, error };
}
