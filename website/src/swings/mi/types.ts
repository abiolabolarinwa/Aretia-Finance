/**
 * Aretia Market Indexer: the records it keeps. Everything here is derived from chain data the indexer read itself;
 * nothing is copied from an aggregator. Amounts are raw integers as decimal strings, prices are fixed-point decimal strings.
 */
import type { MiChain } from './chains.js';

/** Explicit lifecycle of a market (a pool): a token contract alone is never a market. */
export const POOL_STATES = ['discovered', 'validating', 'awaiting_liquidity', 'active', 'inactive', 'suspended', 'unsupported'] as const;
export type PoolState = (typeof POOL_STATES)[number];
export const isPoolState = (v: unknown): v is PoolState => typeof v === 'string' && (POOL_STATES as readonly string[]).includes(v);

/** How strongly a DEX/chain pair is evidenced. Printed by the API, so a claim can be checked. */
export type Evidence = 'planned' | 'address-verified' | 'fixture-tested' | 'live-verified';

/** v2/v3: EVM constant-product / concentrated liquidity. cpmm/clmm: the same two shapes on Solana (Raydium CPMM; Orca Whirlpool). */
export type PoolKind = 'v2' | 'v3' | 'cpmm' | 'clmm';

export interface MiToken {
  /** `chain:address` (EVM addresses lower-case). */
  key: string;
  chain: MiChain;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  /** ms when this indexer first saw the token in a pool. */
  firstSeenAt: number;
  /** ms of the first trade seen in any pool of the token; null until one is. */
  firstTradeAt: number | null;
  /** Set when Aretia Launch Box holds the same token (`chain:address`); the token record is shared, never duplicated. */
  launchboxKey: string | null;
}

export interface MiPool {
  /** `chain:pool` (EVM addresses lower-case). */
  key: string;
  chain: MiChain;
  address: string;
  adapterId: string;
  dex: string;
  kind: PoolKind;
  /** Fee in hundredths of a basis point for V3 pools (3000 = 0.30%); V2 pools use the venue's fixed fee. */
  feeTier: number | null;
  /** The token being priced, and what it is priced in. Addresses, lower-case. */
  base: string;
  quote: string;
  baseDecimals: number;
  quoteDecimals: number;
  /** Which of the pool's two tokens is the base. */
  baseIsToken0: boolean;
  /** Solana: the pool's two token accounts, whose balance changes are its swaps and whose balances are its liquidity. Null on EVM. */
  baseVault: string | null;
  quoteVault: string | null;
  createdBlock: number;
  createdTx: string;
  /** ms, block timestamp of the creation event. */
  createdAt: number;
  state: PoolState;
  stateReason: string;
  stateAt: number;
  /** Token amounts the pool holds, raw, as of `reserveBlock`. Null before they were read. */
  reserveBase: string | null;
  reserveQuote: string | null;
  reserveBlock: number | null;
  firstTradeAt: number | null;
  lastTradeAt: number | null;
  /** Set by an admin; a paused market is not listed and not updated. */
  paused: boolean;
  /** Rolling market numbers computed from this indexer's own trades; null before the first trade. */
  stats: PoolStats | null;
}

/** Numbers derived from stored trades. Volume is in whole quote tokens (a display number); the facts stay in the trades. */
export interface PoolStats {
  /** ms the numbers were computed. */
  asOf: number;
  /** Latest trade price, quote per base, fixed-point decimal string. */
  price: string | null;
  priceUsd: number | null;
  /** What one whole quote token was worth in dollars when these numbers were computed (null = unknown). */
  quoteUsd: number | null;
  /** Price change in basis points over each window; null when the pool had no trade before the window to compare with. */
  change: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  volumeQuote: { m5: number; h1: number; h6: number; h24: number };
  volumeUsd: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  buys: { m5: number; h1: number; h6: number; h24: number };
  sells: { m5: number; h1: number; h6: number; h24: number };
  /** Largest single trade as a share of 24h volume (0..1), and distinct receiving accounts in 24h: inputs to the trending safeguards. */
  maxTradeShare24h: number;
  makers24h: number;
  liquidityQuote: number | null;
  liquidityUsd: number | null;
}

export interface MiTrade {
  chain: MiChain;
  pool: string;
  /** Unique within a pool: `txHash:logIndex`. */
  id: string;
  block: number;
  blockHash: string;
  /** Unix seconds. */
  time: number;
  side: 'buy' | 'sell';
  baseAmount: string;
  quoteAmount: string;
  /** Quote tokens per base token, fixed-point decimal string (see math.ts). */
  price: string;
  /** The account that received the output of the swap (not necessarily the originator). */
  maker: string;
}

export interface Checkpoint {
  adapterId: string;
  block: number;
  blockHash: string;
  updatedAt: number;
}

export interface AdapterHealth {
  adapterId: string;
  chain: MiChain;
  head: number | null;
  safeHead: number | null;
  checkpoint: number | null;
  lagBlocks: number | null;
  lastRunAt: number;
  lastSuccessAt: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  stats: Record<string, number>;
}

export interface AuditEntry {
  at: number;
  actor: string;
  action: string;
  target: string;
  detail: Record<string, unknown>;
}

export interface BackfillJob {
  id: string;
  adapterId: string;
  fromBlock: number;
  toBlock: number;
  /** The block up to which the job has been processed (inclusive); fromBlock - 1 before it starts. */
  doneBlock: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  requestedBy: string;
  requestedAt: number;
  error: string | null;
}

export const tokenKeyOf = (chain: MiChain, address: string): string => `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;
export const poolKeyOf = tokenKeyOf;
