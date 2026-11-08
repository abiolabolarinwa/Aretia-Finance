/**
 * The Markets lists leave out tokens with under $1,000 of liquidity unless the person chooses a lower bar. Nothing under $100 is ever listed, on any network. The choice is kept in this
 * browser (and in memory when the browser will not store it), so choosing "Any liquidity" sticks.
 */
import type { StorageLike } from '../swings/history.js';

const STORED_AS = 'aretia-market-min-liquidity-v1';
export const DEFAULT_MIN_LIQUIDITY = '1000';
/** The lowest bar there is: a token with less than this in its pool is never listed. */
export const FLOOR_LIQUIDITY_USD = 100;
export const MIN_LIQUIDITY_CHOICES: [string, string][] = [['100', '$100+'], ['1000', '$1K+'], ['10000', '$10K+'], ['100000', '$100K+'], ['1000000', '$1M+']];

let remembered: string | null = null;

export function loadMinLiquidity(storage: StorageLike | null): string {
  if (remembered !== null) return remembered;
  try {
    const v = storage?.getItem(STORED_AS);
    // "Any liquidity" (0) was chosen before the floor existed: it now means the floor.
    if (v === '0') return '100';
    if (v && MIN_LIQUIDITY_CHOICES.some(([c]) => c === v)) return v;
  } catch {
    // storage unavailable: the default stands
  }
  return DEFAULT_MIN_LIQUIDITY;
}

export function saveMinLiquidity(storage: StorageLike | null, value: string): void {
  remembered = value;
  try {
    storage?.setItem(STORED_AS, value);
  } catch {
    // kept in memory for this visit
  }
}

export function resetMinLiquidityMemory(): void {
  remembered = null;
}

/** Whether a row's liquidity clears the minimum, and never less than the floor. A pool whose liquidity is unknown does not clear it. */
export function clearsMinLiquidity(liquidityUsd: number | null, min: string): boolean {
  const n = Math.max(Number(min) || 0, FLOOR_LIQUIDITY_USD);
  return liquidityUsd !== null && Number.isFinite(liquidityUsd) && liquidityUsd >= n;
}
