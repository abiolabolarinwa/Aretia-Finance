/**
 * Direct integration with Curve's standard stable-swap pools: each pool is its own contract, quoted by its own
 * `get_dy` and swapped with its own `exchange`. No aggregator is involved.
 *
 * Scope, stated plainly: plain pools with ERC-20 coins addressed by `int128` indices (3pool and its relatives).
 * Crypto pools (uint256 indices), pools holding the native coin, and lending pools that need
 * `exchange_underlying` are not covered. Each listed pool is checked on-chain (its coins and a live `get_dy`)
 * before it is used, so a pool of another kind simply never produces a route.
 */
import type { EvmRead } from '../chains/evmSession.js';
import { normalizeTokenRef } from '../core/token.js';
import { SwingsError } from '../core/types.js';
import { decodeParams, encodeFunction } from '../engine/abiGeneric.js';
import type { DexEntry } from '../engine/registry.js';
import type { EvmTxPlan } from '../execution/evmV2Builder.js';

const SIG = {
  coins: 'coins(uint256)',
  getDy: 'get_dy(int128,int128,uint256)',
  exchange: 'exchange(int128,int128,uint256,uint256)',
} as const;
const MAX_COINS = 8;

export interface CurveRoute {
  pool: string;
  i: number;
  j: number;
  amountOut: bigint;
}

export class EvmCurveAdapter {
  private readonly coinsCache = new Map<string, string[] | null>();

  constructor(
    readonly entry: DexEntry,
    private readonly read: EvmRead,
  ) {
    if (entry.mechanism !== 'evm-curve-pool') throw new SwingsError('invalid', `${entry.id} is not a Curve entry.`);
  }

  private async call(to: string, data: string, block?: bigint): Promise<string> {
    const out = await this.read('eth_call', [{ to, data }, block === undefined ? 'latest' : '0x' + block.toString(16)]);
    if (typeof out !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(out)) throw new SwingsError('invalid', 'The node returned malformed data.');
    return out;
  }

  /** The pool's coins, read from the pool itself (reading stops at the first index it rejects). Null if none can be read. */
  async coins(pool: string): Promise<string[] | null> {
    const key = pool.toLowerCase();
    if (this.coinsCache.has(key)) return this.coinsCache.get(key)!;
    const found: string[] = [];
    for (let i = 0; i < MAX_COINS; i++) {
      try {
        const [coin] = decodeParams(['address'], await this.call(key, encodeFunction(SIG.coins, [BigInt(i)]))) as [string];
        found.push(coin.toLowerCase());
      } catch {
        break;
      }
    }
    const coins = found.length >= 2 ? found : null;
    this.coinsCache.set(key, coins);
    return coins;
  }

  /** What the pool itself says `dx` of coin `i` buys of coin `j`; null if the pool refuses. */
  async quote(pool: string, i: number, j: number, dx: bigint, block?: bigint): Promise<bigint | null> {
    try {
      const [dy] = decodeParams(['uint256'], await this.call(pool, encodeFunction(SIG.getDy, [BigInt(i), BigInt(j), dx]), block)) as [bigint];
      return dy > 0n ? dy : null;
    } catch {
      return null;
    }
  }

  async bestRoute(tokenIn: string, tokenOut: string, amountIn: bigint, block?: bigint): Promise<CurveRoute | null> {
    const a = normalizeTokenRef(this.entry.chain, tokenIn);
    const b = normalizeTokenRef(this.entry.chain, tokenOut);
    if (!a || !b || a.address === b.address) throw new SwingsError('invalid', 'Invalid token pair for this network.');
    if (amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
    const quoted = await Promise.all(
      (this.entry.knownPools ?? []).map(async (pool): Promise<CurveRoute | null> => {
        const coins = await this.coins(pool);
        if (!coins) return null;
        const i = coins.indexOf(a.address);
        const j = coins.indexOf(b.address);
        if (i < 0 || j < 0) return null;
        const amountOut = await this.quote(pool, i, j, amountIn, block);
        return amountOut === null ? null : { pool: pool.toLowerCase(), i, j, amountOut };
      }),
    );
    return quoted.filter((q): q is CurveRoute => q !== null).sort((x, y) => (x.amountOut > y.amountOut ? -1 : 1))[0] ?? null;
  }
}

export interface CurveSwapParams {
  pool: string;
  i: number;
  j: number;
  /** The token being sold (needed for the approval). */
  tokenIn: string;
  amountIn: bigint;
  minOut: bigint;
}

const isAddr = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

/**
 * `exchange(i, j, dx, min_dy)` on one pool. The pool pays the caller, so there is no recipient or deadline: the
 * floor (`min_dy`) is enforced by the pool itself and the transaction either fills or reverts.
 */
export function buildCurveSwap(entry: DexEntry, p: CurveSwapParams): EvmTxPlan {
  if (entry.mechanism !== 'evm-curve-pool') throw new SwingsError('invalid', `${entry.id} cannot build Curve swaps.`);
  if (!isAddr(p.pool) || !isAddr(p.tokenIn)) throw new SwingsError('invalid', 'Invalid address.');
  if (!(entry.knownPools ?? []).some((k) => k.toLowerCase() === p.pool.toLowerCase())) throw new SwingsError('invalid', 'This pool is not one Aretia recognises. It was blocked.');
  if (!Number.isInteger(p.i) || !Number.isInteger(p.j) || p.i < 0 || p.j < 0 || p.i === p.j || p.i >= MAX_COINS || p.j >= MAX_COINS) throw new SwingsError('invalid', 'Invalid coin indices.');
  if (p.amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (p.minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  const pool = p.pool.toLowerCase();
  return {
    chain: entry.chain,
    to: pool,
    data: encodeFunction(SIG.exchange, [BigInt(p.i), BigInt(p.j), p.amountIn, p.minOut]),
    value: 0n,
    approval: { token: p.tokenIn.toLowerCase(), spender: pool, amount: p.amountIn },
    summary: `${entry.name}: sell ${p.amountIn} (raw) of coin ${p.i} for at least ${p.minOut} (raw) of coin ${p.j} in pool ${pool}.`,
  };
}

export interface InspectedCurveSwap {
  pool: string;
  i: number;
  j: number;
  amountIn: bigint;
  minOut: bigint;
}

/** Reads an `exchange` call back into its parts. Null for any other call. */
export function inspectCurveSwap(to: string, data: string): InspectedCurveSwap | null {
  try {
    const sel = encodeFunction(SIG.exchange, [0n, 1n, 1n, 1n]).slice(0, 10);
    if (data.slice(0, 10).toLowerCase() !== sel) return null;
    const [i, j, dx, min] = decodeParams(['int128', 'int128', 'uint256', 'uint256'], '0x' + data.slice(10)) as [bigint, bigint, bigint, bigint];
    return { pool: to.toLowerCase(), i: Number(i), j: Number(j), amountIn: dx, minOut: min };
  } catch {
    return null;
  }
}
