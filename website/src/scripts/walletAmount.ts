/**
 * The 10%, 50% and Max buttons under "You pay". Pure arithmetic on the exact balance in the token's smallest unit, so no
 * rounding up can ever ask for more than is held. Spending the native coin leaves a little behind for the network fee.
 */
import type { ChainId } from '../swings/core/types.js';

/**
 * Kept back when the coin being spent is the chain's own, so the swap can still pay its fee. A cushion, not a quote: the real
 * check is still made when the price is read, and it says so plainly if the fee cannot be covered. In whole coins, as text.
 */
export const FEE_CUSHION: Readonly<Record<ChainId, string>> = {
  solana: '0.005',
  ethereum: '0.004',
  bnb: '0.002',
  polygon: '0.1',
  base: '0.0005',
  arbitrum: '0.0005',
  optimism: '0.0005',
  avalanche: '0.02',
  robinhood: '0.0005',
};

/** A decimal string such as "0.0005" as a whole number of the smallest unit. */
export function cushionUnits(coins: string, decimals: number): bigint {
  const [whole, frac = ''] = coins.split('.');
  return BigInt(whole + frac.padEnd(decimals, '0').slice(0, decimals));
}

export const SHARES = [10, 50, 100] as const;
export type Share = (typeof SHARES)[number];

/**
 * What to put in the amount box for a share of the balance. 100 is "Max". Never more than is held, never negative, and for
 * the native coin never into the fee cushion.
 */
export function shareOfBalance(balance: bigint, pct: Share, native: { cushion: bigint } | null): bigint {
  if (balance <= 0n) return 0n;
  const spendable = native ? (balance > native.cushion ? balance - native.cushion : 0n) : balance;
  const part = (balance * BigInt(pct)) / 100n;
  return part < spendable ? part : spendable;
}
