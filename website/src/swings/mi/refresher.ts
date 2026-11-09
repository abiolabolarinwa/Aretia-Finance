/**
 * Reserves refresher: keeps the liquidity of every known pool of one adapter current from the pools' own on-chain reserves, so the
 * index can rank thousands of pools by liquidity without following each one's swaps.
 *
 * Each pass takes the pools written least recently (oldest first, so every pool is reached in turn), reads their reserves in batches
 * through Multicall3 (reserves.ts), re-evaluates their listing state with the usual rules (lifecycle.ts) and stores the liquidity.
 *
 * What it will not do: invent trade figures. A pool with at least one stored trade gets its full numbers recomputed from those trades
 * (exactly as the engine does); a pool with none gets liquidity-only stats (`reservesOnly`), whose trade price, change, volume and
 * transaction counts stay absent. Its current price, read from the reserves (V2) or the pool's own price (V3), is kept apart as
 * `reservePrice` / `reservePriceUsd`, so a list can show it marked as a reserve price and never as a trade price. Dollar liquidity exists only where the quote token's dollar price is known (stablecoin, or the
 * chain's coin with a readable reference price).
 */
import type { MiChainConfig } from './chains.js';
import type { DexAdapterSpec } from './dexes.js';
import { evaluate, type ListingRules } from './lifecycle.js';
import { liquidityUsdOf, MULTICALL_CHAINS, quoteUsdFor, readReservesBatch, reservePriceOf, type ReserveQuery } from './reserves.js';
import { RpcError, type Read } from './rpc.js';
import { computeStats } from './stats.js';
import type { MiStore } from './store.js';
import type { MiPool, PoolStats } from './types.js';

export interface RefreshDeps {
  spec: DexAdapterSpec;
  chain: MiChainConfig;
  read: Read;
  store: MiStore;
  rules: ListingRules;
  now: () => number;
  nativeUsd?: () => Promise<number | null>;
  /** Wall-clock budget for one pass, ms. */
  budgetMs: number;
  /** Pools read per node request (default 150). */
  batch?: number;
  /** Pools considered per pass at most (default 1500). */
  limit?: number;
}

export interface RefreshReport {
  adapterId: string;
  ok: boolean;
  skipped: 'unsupported' | null;
  considered: number;
  read: number;
  unreadable: number;
  stateChanges: number;
  error: string | null;
  durationMs: number;
}

/** States the refresher maintains. `validating` is left to the engine, which still has to read the pool's tokens. */
export const REFRESH_STATES = ['awaiting_liquidity', 'active', 'inactive'] as const;

export async function refreshReserves(d: RefreshDeps): Promise<RefreshReport> {
  const t0 = d.now();
  const r: RefreshReport = { adapterId: d.spec.id, ok: true, skipped: null, considered: 0, read: 0, unreadable: 0, stateChanges: 0, error: null, durationMs: 0 };
  if (d.spec.kind === 'v4' || !MULTICALL_CHAINS.includes(d.chain.id)) {
    r.skipped = 'unsupported';
    return r;
  }
  try {
    if ((await d.store.disabledAdapters()).has(d.spec.id)) return { ...r, skipped: 'unsupported' };
    const pools = await d.store.poolsOfAdapter(d.spec.id, REFRESH_STATES, d.limit ?? 1_500, 'stale');
    r.considered = pools.length;
    const size = Math.max(1, d.batch ?? 150);
    const deadline = t0 + d.budgetMs;
    for (let i = 0; i < pools.length && d.now() < deadline; i += size) {
      const group = pools.slice(i, i + size).filter((p) => p.kind === 'v2' || p.kind === 'v3');
      const queries: ReserveQuery[] = group.map((p) => ({ kind: p.kind as 'v2' | 'v3', pool: p.address, base: p.base, quote: p.quote, baseIsToken0: p.baseIsToken0 }));
      const reserves = await readReservesBatch(d.read, queries);
      for (let k = 0; k < group.length; k++) {
        const pool = group[k]!;
        const res = reserves[k]!;
        if (!res) {
          // Not answered: move it to the back of the queue without changing what is stored.
          r.unreadable++;
          await d.store.updatePool(pool.key, {});
          continue;
        }
        r.read++;
        if (await applyReserves(d, pool, res)) r.stateChanges++;
      }
    }
  } catch (e) {
    r.ok = false;
    r.error = (e instanceof RpcError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : 'the refresh failed').slice(0, 300);
  }
  r.durationMs = d.now() - t0;
  return r;
}

/** Stores one pool's fresh reserves; returns true when its listing state changed. */
async function applyReserves(d: RefreshDeps, pool: MiPool, res: { base: bigint; quote: bigint; sqrtPriceX96?: bigint }): Promise<boolean> {
  const now = d.now();
  const quoteUsd = await quoteUsdFor(d.chain, pool.quote, d.nativeUsd);
  const liquidityUsd = liquidityUsdOf(res.quote, pool.quoteDecimals, quoteUsd);
  const ev = evaluate(
    pool.state,
    { tokensReadable: true, quoteRecognised: true, reserveBase: res.base, reserveQuote: res.quote, liquidityUsd, createdAt: pool.createdAt, firstSeenAt: pool.stateAt, lastTradeAt: pool.lastTradeAt, paused: pool.paused },
    d.rules,
    now,
  );
  let stats: PoolStats | null;
  if (pool.lastTradeAt !== null) {
    const since = Math.floor(now / 1000) - 86_400;
    const [recent, prior] = await Promise.all([d.store.tradesSince(pool.chain, pool.address, since, 5_000), d.store.lastTradeBefore(pool.chain, pool.address, since)]);
    stats = computeStats(pool, recent, prior, now, { quoteUsd }, res.quote);
  } else {
    stats = null;
  }
  const liquidityQuote = (Number(res.quote) / 10 ** pool.quoteDecimals) * 2;
  const patch: Partial<MiPool> = {
    reserveBase: res.base.toString(),
    reserveQuote: res.quote.toString(),
    stats: stats ?? liquidityOnly(now, quoteUsd, liquidityQuote, liquidityUsd, pool.kind === 'v2' || pool.kind === 'v3' ? reservePriceOf(pool.kind, res, pool.baseIsToken0, pool.baseDecimals, pool.quoteDecimals, quoteUsd) : null),
  };
  const changed = ev.state !== pool.state;
  if (changed) {
    patch.state = ev.state;
    patch.stateReason = ev.reason;
    patch.stateAt = now;
  }
  await d.store.updatePool(pool.key, patch);
  return changed;
}

/** Stats for a pool with no stored trade: its liquidity and nothing else (see PoolStats.reservesOnly). */
export function liquidityOnly(asOf: number, quoteUsd: number | null, liquidityQuote: number, liquidityUsd: number | null, reserve: { price: string; usd: number | null } | null = null): PoolStats {
  return {
    asOf,
    price: null,
    priceUsd: null,
    quoteUsd,
    change: { m5: null, h1: null, h6: null, h24: null },
    volumeQuote: { m5: 0, h1: 0, h6: 0, h24: 0 },
    volumeUsd: { m5: null, h1: null, h6: null, h24: null },
    buys: { m5: 0, h1: 0, h6: 0, h24: 0 },
    sells: { m5: 0, h1: 0, h6: 0, h24: 0 },
    maxTradeShare24h: 0,
    makers24h: 0,
    liquidityQuote,
    liquidityUsd,
    reservesOnly: true,
    ...(reserve ? { reservePrice: reserve.price, reservePriceUsd: reserve.usd } : {}),
  };
}
