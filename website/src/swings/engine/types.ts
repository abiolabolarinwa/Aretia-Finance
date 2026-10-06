/**
 * Aretia engine domain types. These describe pools, liquidity and routes from the chain's point of view.
 * They know nothing about Jupiter, 0x, ethers or any individual DEX: a venue is reached through a
 * DexAdapter and described by a registry entry.
 */
import type { ChainId, TokenRef } from '../core/types.js';

export type ChainType = 'solana' | 'evm';

/** How a pool prices a swap. Different models need different maths; none is assumed. */
export type PoolModel = 'constant-product' | 'concentrated' | 'stable';

export interface PoolRef {
  chain: ChainId;
  /** Registry id of the venue, for example `uniswap-v2`. */
  dex: string;
  /** Pool or pair contract address (lower-case for EVM). */
  address: string;
}

export interface LiquidityPool {
  ref: PoolRef;
  model: PoolModel;
  token0: TokenRef;
  token1: TokenRef;
  /** Raw reserves. For concentrated pools these are the pool's token balances, not the active range. */
  reserve0: bigint;
  reserve1: bigint;
  /** Swap fee in parts per million (3000 = 0.30%). */
  feePpm: number;
  /**
   * Which constant-product formula prices this pool. Venues round differently, and an exact quote needs the venue's
   * own rounding. Absent means the Uniswap V2 formula.
   */
  curve?: 'uniswap-v2' | 'raydium-cpmm';
  /** Venue-specific facts needed to build a swap (account addresses and the like). Opaque to the engine. */
  extra?: Readonly<Record<string, string>>;
  /** Ms epoch when the numbers were read, and the block (or slot) they were read at. */
  updatedAt: number;
  block: bigint | null;
  status: 'active' | 'inactive';
}

/** True when Aretia can compute this pool's swaps exactly on its own (needed to simulate splits). */
export const isSimulable = (p: LiquidityPool): boolean => p.model === 'constant-product';

export interface SwapPair {
  tokenIn: TokenRef;
  tokenOut: TokenRef;
}

export interface RouteHop {
  pool: LiquidityPool;
  tokenIn: TokenRef;
  tokenOut: TokenRef;
  amountIn: bigint;
  amountOut: bigint;
}

export interface PlannedRoute {
  hops: RouteHop[];
  amountIn: bigint;
  amountOut: bigint;
  /** Output the route would give for a negligible trade, scaled to the same input: the no-impact reference. */
  idealOut: bigint;
  /** 0 to 10000. How much of the ideal output was lost to the trade moving the price (fees included). */
  priceImpactBps: number;
  /** Deterministic score in output-token units (higher is better), and the reasons behind it. */
  score: bigint;
  reasons: string[];
}

export interface SplitLeg {
  share: PlannedRoute;
  /** Share of the input in basis points. */
  shareBps: number;
}

export interface SplitRoute {
  legs: SplitLeg[];
  amountIn: bigint;
  amountOut: bigint;
  /** How much more this pays than the best single route, in basis points of that route's output. */
  improvementBps: number;
}

export type ExecutionStatus = 'PENDING' | 'SIGNED' | 'SUBMITTED' | 'CONFIRMED' | 'FAILED' | 'EXPIRED' | 'UNKNOWN';

export type DexStatus = 'ACTIVE' | 'DEGRADED' | 'DISABLED' | 'MAINTENANCE';

export interface LiquiditySnapshot {
  pool: PoolRef;
  reserve0: bigint;
  reserve1: bigint;
  updatedAt: number;
  block: bigint | null;
}

export interface MarketSnapshot {
  pair: SwapPair;
  /** Price of tokenIn in tokenOut, scaled by 1e18 and adjusted for both tokens' decimals. */
  price1e18: bigint;
  liquidityWeightedPrice1e18: bigint;
  poolCount: number;
  updatedAt: number;
}
