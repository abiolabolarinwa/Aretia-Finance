/**
 * A token opened by its address alone (the top ticker, a search result, a notification, a link) has no pool yet. This finds
 * its best real pool (the finder prefers a pool against a major coin, then the most liquidity) and puts it on the row, so the
 * chart, trades and numbers are only ever asked for a pool that exists. No pool is an answer of its own, not an error: a token
 * still on its launch curve has none.
 */
import { SwingsError } from '../core/types.js';
import type { PoolInfo } from '../charts/pool.js';
import type { MarketRow } from './types.js';

export type PoolResolution = { status: 'ready'; row: MarketRow } | { status: 'none'; row: MarketRow } | { status: 'failed'; row: MarketRow; message: string };

/** The quote coin's symbol out of a pool name like "BONK / SOL". */
const quoteOf = (poolName: string): string => {
  const parts = poolName.split('/').map((s) => s.trim());
  return parts.length > 1 ? [...(parts[1] ?? '')].filter((c) => c.charCodeAt(0) > 31).join('').slice(0, 20) : '';
};

export async function resolveRowPool(row: MarketRow, find: (chain: MarketRow['chain'], address: string) => Promise<PoolInfo>): Promise<PoolResolution> {
  if (row.pool) return { status: 'ready', row };
  try {
    const p = await find(row.chain, row.address);
    return {
      status: 'ready',
      row: { ...row, pool: p.pool, quoteSymbol: row.quoteSymbol || quoteOf(p.poolName), priceUsd: row.priceUsd ?? p.priceUsd, liquidityUsd: row.liquidityUsd ?? p.liquidityUsd, change: { ...row.change, h24: row.change.h24 ?? p.change24h } },
    };
  } catch (e) {
    if (e instanceof SwingsError && e.code === 'no-route') return { status: 'none', row };
    return { status: 'failed', row, message: e instanceof Error ? e.message : 'The pool could not be looked up.' };
  }
}
