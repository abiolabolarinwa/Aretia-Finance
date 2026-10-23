/**
 * Market lifecycle. A pure function from what the indexer knows about a pool to its state, so every transition is
 * explainable and testable.
 *
 *   discovered          the creation event was seen; nothing has been checked yet
 *   validating          token facts / reserves are being read
 *   awaiting_liquidity  the pool exists but holds no (or too little) liquidity: not a market yet
 *   active              both tokens readable, a recognised quote token, liquidity present, recent enough
 *   inactive            was a market, but liquidity is gone or nothing traded within the window
 *   suspended           an admin paused it, or a safety rule did; only an explicit resume leaves this state
 *   unsupported         can never be listed under the current rules (unreadable token, no recognised quote token)
 */
import type { PoolState } from './types.js';

export interface ListingRules {
  /** A pool must have a quote token Aretia recognises (wrapped native or a major stablecoin). */
  requireKnownQuote: boolean;
  /** Applies only where the pool's liquidity in dollars is known (a stablecoin quote). */
  minLiquidityUsd: number;
  /** A pool with no trade for this long stops being active. */
  inactiveAfterMs: number;
  /** A pool that stays in validating longer than this is marked unsupported (token facts never became readable). */
  validatingTimeoutMs: number;
}

export const DEFAULT_RULES: ListingRules = {
  requireKnownQuote: true,
  minLiquidityUsd: 500,
  inactiveAfterMs: 7 * 86_400_000,
  validatingTimeoutMs: 6 * 3_600_000,
};

export interface PoolFacts {
  /** null: not checked yet. false: a token of the pool could not be read as an ERC-20. */
  tokensReadable: boolean | null;
  quoteRecognised: boolean;
  reserveBase: bigint | null;
  reserveQuote: bigint | null;
  /** Liquidity in dollars when the quote is a dollar stablecoin; otherwise null (unknown, never guessed). */
  liquidityUsd: number | null;
  createdAt: number;
  firstSeenAt: number;
  lastTradeAt: number | null;
  paused: boolean;
}

export interface Evaluation {
  state: PoolState;
  reason: string;
}

export function evaluate(current: PoolState, f: PoolFacts, rules: ListingRules, now: number): Evaluation {
  if (f.paused || current === 'suspended') return { state: 'suspended', reason: f.paused ? 'paused by an administrator' : 'suspended; waiting for an explicit resume' };
  if (f.tokensReadable === false) return { state: 'unsupported', reason: 'a token of the pool is not a readable ERC-20' };
  if (!f.quoteRecognised && rules.requireKnownQuote) return { state: 'unsupported', reason: 'neither token is a recognised quote token' };
  if (f.tokensReadable === null) {
    if (now - f.firstSeenAt > rules.validatingTimeoutMs) return { state: 'unsupported', reason: 'token facts could not be read in time' };
    return { state: 'validating', reason: 'reading token facts' };
  }
  if (f.reserveBase === null || f.reserveQuote === null) return { state: 'validating', reason: 'reading pool reserves' };
  if (f.reserveBase <= 0n || f.reserveQuote <= 0n) {
    // A pool that was a market and has been drained is inactive; one that never held liquidity is still waiting.
    return f.lastTradeAt !== null ? { state: 'inactive', reason: 'liquidity was removed' } : { state: 'awaiting_liquidity', reason: 'the pool holds no liquidity yet' };
  }
  if (f.liquidityUsd !== null && f.liquidityUsd < rules.minLiquidityUsd) return { state: 'awaiting_liquidity', reason: `liquidity is below the listing minimum of $${rules.minLiquidityUsd}` };
  const last = f.lastTradeAt ?? f.createdAt;
  if (now - last > rules.inactiveAfterMs) return { state: 'inactive', reason: f.lastTradeAt === null ? 'no trade since creation' : 'no trade within the activity window' };
  return { state: 'active', reason: 'liquidity present and recently active' };
}

/** What an administrator may do to a state. */
export function adminTransition(current: PoolState, action: 'suspend' | 'resume'): PoolState | null {
  if (action === 'suspend') return current === 'suspended' ? null : 'suspended';
  return current === 'suspended' ? 'validating' : null;
}

/** States whose pools appear in public lists. */
export const LISTED_STATES: readonly PoolState[] = ['active'];
/** States whose pools still have swaps followed. */
export const FOLLOWED_STATES: readonly PoolState[] = ['validating', 'awaiting_liquidity', 'active', 'inactive'];
