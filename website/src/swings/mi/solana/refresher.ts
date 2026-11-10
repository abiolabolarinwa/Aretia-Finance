/**
 * Solana reserves refresher: keeps the liquidity of every known pool of one Solana adapter current from its two token accounts, so the
 * index can rank thousands of discovered pools by liquidity without following each one's swaps (the Solana twin of ../refresher.ts).
 *
 * Each pass takes the pools written least recently, reads both vaults of 50 pools per `getMultipleAccounts` call, re-evaluates the listing
 * state with the usual rules and stores the liquidity. A pool with at least one stored trade gets its full numbers recomputed from those
 * trades; a pool with none gets liquidity-only stats (`reservesOnly`). Its price is shown from the vault balances only where the venue is a
 * plain constant-product pool (Raydium CPMM, PumpSwap): for concentrated, bin and bonding-curve venues, and for AMM v4 (part of whose
 * funds sit outside the vaults), the balance ratio is not the price, so no reserve price is stored for them.
 */
import { evaluate } from '../lifecycle.js';
import { priceString } from '../math.js';
import { liquidityOnly, REFRESH_STATES, type RefreshReport } from '../refresher.js';
import { RpcError } from '../rpc.js';
import { computeStats, RECENT_TRADE_LIMIT } from '../stats.js';
import type { MiPool, PoolStats } from '../types.js';
import { tokenAmount } from './accounts.js';
import { accounts, factsOf, quoteUsdOf, type SolDeps } from './engine.js';

/** Venues whose pool is plain constant product over its two vaults: the vault ratio is its price. */
export const VAULT_RATIO_PRICE: readonly string[] = ['raydium-cpmm-solana', 'pumpswap-solana'];

export interface SolRefreshDeps extends SolDeps {
  /** Wall-clock budget for one pass, ms. */
  budgetMs: number;
  /** Pools read per node request (default 50: two vaults each). */
  batch?: number;
  /** Pools considered per pass at most (default 1500). */
  limit?: number;
}

export async function refreshSolanaReserves(d: SolRefreshDeps): Promise<RefreshReport> {
  const t0 = d.now();
  const r: RefreshReport = { adapterId: d.spec.id, ok: true, skipped: null, considered: 0, read: 0, unreadable: 0, stateChanges: 0, error: null, durationMs: 0 };
  try {
    if ((await d.store.disabledAdapters()).has(d.spec.id)) return { ...r, skipped: 'unsupported' };
    const pools = (await d.store.poolsOfAdapter(d.spec.id, REFRESH_STATES, d.limit ?? 1_500, 'stale')).filter((p) => p.baseVault && p.quoteVault);
    r.considered = pools.length;
    const size = Math.max(1, Math.min(50, d.batch ?? 50));
    const deadline = t0 + d.budgetMs;
    for (let i = 0; i < pools.length && d.now() < deadline; i += size) {
      const group = pools.slice(i, i + size);
      const balances = await accounts(d.rpc, group.flatMap((p) => [p.baseVault!, p.quoteVault!]));
      for (const pool of group) {
        const b = balances.get(pool.baseVault!);
        const q = balances.get(pool.quoteVault!);
        const base = b ? tokenAmount(b) : null;
        const quote = q ? tokenAmount(q) : null;
        if (base === null || quote === null) {
          // Not answered: move it to the back of the queue without changing what is stored.
          r.unreadable++;
          await d.store.updatePool(pool.key, {});
          continue;
        }
        r.read++;
        if (await applyVaults(d, pool, { base, quote })) r.stateChanges++;
      }
    }
  } catch (e) {
    r.ok = false;
    r.error = (e instanceof RpcError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : 'the refresh failed').slice(0, 300);
  }
  r.durationMs = d.now() - t0;
  return r;
}

/** Stores one pool's fresh vault balances; returns true when its listing state changed. */
async function applyVaults(d: SolRefreshDeps, pool: MiPool, res: { base: bigint; quote: bigint }): Promise<boolean> {
  const now = d.now();
  const recognised = d.chain.quoteTokens.some((q) => q.address === pool.quote);
  const quoteUsd = await quoteUsdOf(d, pool);
  const facts = await factsOf(d, pool, true, recognised, res);
  const ev = evaluate(pool.state, facts, d.rules, now);
  let stats: PoolStats | null = null;
  if (pool.lastTradeAt !== null) {
    const since = Math.floor(now / 1000) - 86_400;
    const [recent, prior] = await Promise.all([d.store.windowTrades('solana', pool.address, since, RECENT_TRADE_LIMIT), d.store.lastTradeBefore('solana', pool.address, since)]);
    stats = computeStats(pool, recent, prior, now, { quoteUsd }, res.quote);
  }
  if (stats === null) {
    const liquidityQuote = (Number(res.quote) / 10 ** pool.quoteDecimals) * 2;
    const price = VAULT_RATIO_PRICE.includes(d.spec.id) ? priceString(res.base, pool.baseDecimals, res.quote, pool.quoteDecimals) : null;
    const n = price === null ? Number.NaN : Number(price);
    const reserve = price !== null ? { price, usd: quoteUsd !== null && Number.isFinite(n) && n > 0 ? n * quoteUsd : null } : null;
    stats = liquidityOnly(now, quoteUsd, liquidityQuote, facts.liquidityUsd, reserve);
  }
  const patch: Partial<MiPool> = { reserveBase: res.base.toString(), reserveQuote: res.quote.toString(), stats };
  const changed = ev.state !== pool.state;
  if (changed) {
    patch.state = ev.state;
    patch.stateReason = ev.reason;
    patch.stateAt = now;
  }
  await d.store.updatePool(pool.key, patch);
  return changed;
}
