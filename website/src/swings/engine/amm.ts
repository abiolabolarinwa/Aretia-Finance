/**
 * Exact constant-product maths, matching Uniswap V2's `getAmountOut` bit for bit (and its forks, which
 * differ only by fee). All integers (bigint): no floating point anywhere that touches an amount.
 */
import { SwingsError } from '../core/types.js';
import type { LiquidityPool } from './types.js';
import { sameToken } from '../core/token.js';
import type { TokenRef } from '../core/types.js';

const PPM = 1_000_000n;

/** Output for a given input. Throws on empty reserves or a zero input, never returns a negative or absurd value. */
export function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feePpm: number): bigint {
  if (amountIn <= 0n) throw new SwingsError('invalid', 'The input amount must be above zero.');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new SwingsError('no-route', 'The pool has no liquidity.');
  if (!Number.isInteger(feePpm) || feePpm < 0 || feePpm >= 1_000_000) throw new SwingsError('invalid', 'Invalid pool fee.');
  const inWithFee = amountIn * (PPM - BigInt(feePpm));
  return (inWithFee * reserveOut) / (reserveIn * PPM + inWithFee);
}

/** Input needed for a given output (Uniswap V2 `getAmountIn`). */
export function getAmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint, feePpm: number): bigint {
  if (amountOut <= 0n) throw new SwingsError('invalid', 'The output amount must be above zero.');
  if (reserveIn <= 0n || reserveOut <= 0n || amountOut >= reserveOut) throw new SwingsError('no-route', 'The pool cannot supply that amount.');
  return (reserveIn * amountOut * PPM) / ((reserveOut - amountOut) * (PPM - BigInt(feePpm))) + 1n;
}

/** Which side of the pool a token is on: 0, 1, or null if it is not in the pool. */
export function sideOf(pool: LiquidityPool, token: TokenRef): 0 | 1 | null {
  if (sameToken(pool.token0, token)) return 0;
  if (sameToken(pool.token1, token)) return 1;
  return null;
}

/** Reserves oriented as (in, out) for a given input token. */
export function orient(pool: LiquidityPool, tokenIn: TokenRef): { reserveIn: bigint; reserveOut: bigint; tokenOut: TokenRef } {
  const side = sideOf(pool, tokenIn);
  if (side === null) throw new SwingsError('invalid', 'The token is not in this pool.');
  return side === 0 ? { reserveIn: pool.reserve0, reserveOut: pool.reserve1, tokenOut: pool.token1 } : { reserveIn: pool.reserve1, reserveOut: pool.reserve0, tokenOut: pool.token0 };
}

/**
 * Raydium CPMM: the trade fee is rounded UP and taken from the input first, then the constant-product formula is
 * applied to what is left. Matches the program's own `CurveCalculator::swap_base_input` for pools without creator fees.
 */
export function getAmountOutCpmm(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feePpm: number): bigint {
  if (amountIn <= 0n) throw new SwingsError('invalid', 'The input amount must be above zero.');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new SwingsError('no-route', 'The pool has no liquidity.');
  if (!Number.isInteger(feePpm) || feePpm < 0 || feePpm >= 1_000_000) throw new SwingsError('invalid', 'Invalid pool fee.');
  const fee = (amountIn * BigInt(feePpm) + PPM - 1n) / PPM;
  const afterFee = amountIn - fee;
  if (afterFee <= 0n) throw new SwingsError('no-route', 'The amount is too small to swap.');
  return (afterFee * reserveOut) / (reserveIn + afterFee);
}

/** Quote against a constant-product pool, using that venue's own formula. */
export function quoteConstantProduct(pool: LiquidityPool, tokenIn: TokenRef, amountIn: bigint): bigint {
  const { reserveIn, reserveOut } = orient(pool, tokenIn);
  return pool.curve === 'raydium-cpmm' ? getAmountOutCpmm(amountIn, reserveIn, reserveOut, pool.feePpm) : getAmountOut(amountIn, reserveIn, reserveOut, pool.feePpm);
}

/** The pool after the swap has happened (used to simulate several trades in sequence, and splits). */
export function applyConstantProduct(pool: LiquidityPool, tokenIn: TokenRef, amountIn: bigint): { pool: LiquidityPool; amountOut: bigint } {
  const out = quoteConstantProduct(pool, tokenIn, amountIn);
  const side = sideOf(pool, tokenIn)!;
  const next: LiquidityPool = side === 0 ? { ...pool, reserve0: pool.reserve0 + amountIn, reserve1: pool.reserve1 - out } : { ...pool, reserve1: pool.reserve1 + amountIn, reserve0: pool.reserve0 - out };
  return { pool: next, amountOut: out };
}

/**
 * Price impact of a trade in basis points: how far the executed rate falls below the pool's marginal
 * (no-size) rate. Fees count toward it, because both reduce what the user receives.
 */
export function priceImpactBps(amountIn: bigint, amountOut: bigint, reserveIn: bigint, reserveOut: bigint): number {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0;
  const ideal = (amountIn * reserveOut) / reserveIn; // output at the marginal price, before fee and size
  if (ideal <= 0n) return 0;
  const lost = ideal > amountOut ? ideal - amountOut : 0n;
  return Number((lost * 10_000n) / ideal);
}
