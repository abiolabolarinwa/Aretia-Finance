/**
 * Aretia Price Engine: prices come from Aretia's own pool data, never from an exchange feed or an
 * aggregator. Prices are bigint, scaled by 1e18, and expressed as "how much tokenOut for one whole tokenIn",
 * so decimals of both tokens are accounted for.
 */
import { tokenKey } from '../core/token.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import { orient } from './amm.js';
import type { LiquidityStore } from './liquidity.js';
import type { LiquidityPool, MarketSnapshot, SwapPair } from './types.js';

const E18 = 10n ** 18n;

export type DecimalsOf = (token: TokenRef) => number;

/** Marginal (no-size, no-fee) price of tokenIn in tokenOut for one pool. */
export function poolSpotPrice(pool: LiquidityPool, tokenIn: TokenRef, decimals: DecimalsOf): bigint {
  const { reserveIn, reserveOut, tokenOut } = orient(pool, tokenIn);
  if (reserveIn <= 0n || reserveOut <= 0n) throw new SwingsError('no-route', 'The pool has no liquidity.');
  return (reserveOut * 10n ** BigInt(decimals(tokenIn)) * E18) / (reserveIn * 10n ** BigInt(decimals(tokenOut)));
}

export class PriceEngine {
  private readonly samples = new Map<string, { at: number; price: bigint }[]>();

  constructor(
    private readonly store: LiquidityStore,
    private readonly decimals: DecimalsOf,
    private readonly now: () => number = Date.now,
  ) {}

  private pricedPools(pair: SwapPair, maxAgeMs: number): { pool: LiquidityPool; price: bigint; weight: bigint }[] {
    return this.store
      .forPair(pair.tokenIn, pair.tokenOut)
      .filter((p) => p.status === 'active' && this.store.isFresh(p, maxAgeMs))
      .map((pool) => ({ pool, price: poolSpotPrice(pool, pair.tokenIn, this.decimals), weight: orient(pool, pair.tokenIn).reserveIn }));
  }

  /** The price from the single deepest pool (by the input token's reserve). */
  spot(pair: SwapPair, maxAgeMs = 120_000): bigint | null {
    const priced = this.pricedPools(pair, maxAgeMs);
    if (priced.length === 0) return null;
    return priced.reduce((best, x) => (x.weight > best.weight ? x : best)).price;
  }

  /** Midpoint between the lowest and highest pool price: shows disagreement between venues. */
  mid(pair: SwapPair, maxAgeMs = 120_000): bigint | null {
    const priced = this.pricedPools(pair, maxAgeMs);
    if (priced.length === 0) return null;
    const prices = priced.map((x) => x.price);
    const lo = prices.reduce((a, b) => (a < b ? a : b));
    const hi = prices.reduce((a, b) => (a > b ? a : b));
    return (lo + hi) / 2n;
  }

  /** Price averaged across pools, weighted by how much of the input token each holds. Deeper pools count more. */
  liquidityWeighted(pair: SwapPair, maxAgeMs = 120_000): bigint | null {
    const priced = this.pricedPools(pair, maxAgeMs);
    const total = priced.reduce((s, x) => s + x.weight, 0n);
    if (priced.length === 0 || total === 0n) return null;
    return priced.reduce((s, x) => s + x.price * x.weight, 0n) / total;
  }

  /** Records the current liquidity-weighted price so a TWAP can be taken later. */
  observe(pair: SwapPair): void {
    const price = this.liquidityWeighted(pair);
    if (price === null) return;
    const key = `${tokenKey(pair.tokenIn)}>${tokenKey(pair.tokenOut)}`;
    const list = this.samples.get(key) ?? [];
    list.push({ at: this.now(), price });
    if (list.length > 500) list.shift();
    this.samples.set(key, list);
  }

  /** Time-weighted average of recorded observations over a window. Null when there are fewer than two. */
  twap(pair: SwapPair, windowMs: number): bigint | null {
    const key = `${tokenKey(pair.tokenIn)}>${tokenKey(pair.tokenOut)}`;
    const end = this.now();
    const list = (this.samples.get(key) ?? []).filter((s) => s.at >= end - windowMs);
    if (list.length < 2) return null;
    let weighted = 0n;
    let span = 0n;
    for (let i = 0; i < list.length - 1; i++) {
      const dt = BigInt(list[i + 1]!.at - list[i]!.at);
      weighted += list[i]!.price * dt;
      span += dt;
    }
    return span === 0n ? null : weighted / span;
  }

  market(pair: SwapPair): MarketSnapshot | null {
    const spot = this.spot(pair);
    const lw = this.liquidityWeighted(pair);
    if (spot === null || lw === null) return null;
    return { pair, price1e18: spot, liquidityWeightedPrice1e18: lw, poolCount: this.pricedPools(pair, 120_000).length, updatedAt: this.now() };
  }
}
