/**
 * Aretia Liquidity Engine (in-memory part): the current view of every pool Aretia knows, with the time and
 * block each was read. Venue adapters and (later) indexers write into it; routing and pricing read from it.
 * Staleness is explicit: nothing here pretends old numbers are current.
 */
import { tokenKey } from '../core/token.js';
import type { TokenRef } from '../core/types.js';
import type { LiquidityPool, LiquiditySnapshot } from './types.js';

const poolKey = (p: LiquidityPool): string => `${p.ref.chain}:${p.ref.dex}:${p.ref.address}`;

export class LiquidityStore {
  private readonly pools = new Map<string, LiquidityPool>();
  private readonly byToken = new Map<string, Set<string>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Adds or replaces a pool. An older read never overwrites a newer one for the same pool. */
  put(pool: LiquidityPool): boolean {
    const key = poolKey(pool);
    const existing = this.pools.get(key);
    if (existing && existing.updatedAt > pool.updatedAt) return false;
    if (existing && existing.block !== null && pool.block !== null && existing.block > pool.block) return false;
    this.pools.set(key, pool);
    for (const t of [pool.token0, pool.token1]) {
      const k = tokenKey(t);
      const set = this.byToken.get(k) ?? new Set<string>();
      set.add(key);
      this.byToken.set(k, set);
    }
    return true;
  }

  remove(pool: Pick<LiquidityPool, 'ref'>): void {
    const key = `${pool.ref.chain}:${pool.ref.dex}:${pool.ref.address}`;
    const p = this.pools.get(key);
    if (!p) return;
    this.pools.delete(key);
    for (const t of [p.token0, p.token1]) this.byToken.get(tokenKey(t))?.delete(key);
  }

  /** All pools that contain a token. */
  forToken(token: TokenRef): LiquidityPool[] {
    return [...(this.byToken.get(tokenKey(token)) ?? [])].map((k) => this.pools.get(k)!).filter(Boolean);
  }

  forPair(a: TokenRef, b: TokenRef): LiquidityPool[] {
    const kb = tokenKey(b);
    return this.forToken(a).filter((p) => tokenKey(p.token0) === kb || tokenKey(p.token1) === kb);
  }

  ageMs(pool: LiquidityPool): number {
    return Math.max(0, this.now() - pool.updatedAt);
  }

  isFresh(pool: LiquidityPool, maxAgeMs: number): boolean {
    return this.ageMs(pool) <= maxAgeMs;
  }

  snapshot(pool: LiquidityPool): LiquiditySnapshot {
    return { pool: pool.ref, reserve0: pool.reserve0, reserve1: pool.reserve1, updatedAt: pool.updatedAt, block: pool.block };
  }

  size(): number {
    return this.pools.size;
  }

  all(): LiquidityPool[] {
    return [...this.pools.values()];
  }
}
