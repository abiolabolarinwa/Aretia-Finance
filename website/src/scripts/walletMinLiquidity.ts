/**
 * The Markets lists leave out tokens with under $1,000 of liquidity unless the person chooses to see them. The choice is kept in this
 * browser (and in memory when the browser will not store it), so choosing "Any liquidity" sticks.
 */
import type { StorageLike } from '../swings/history.js';

const STORED_AS = 'aretia-market-min-liquidity-v1';
export const DEFAULT_MIN_LIQUIDITY = '1000';
export const MIN_LIQUIDITY_CHOICES: [string, string][] = [['0', 'Any liquidity'], ['1000', '$1K+'], ['10000', '$10K+'], ['100000', '$100K+'], ['1000000', '$1M+']];

let remembered: string | null = null;

export function loadMinLiquidity(storage: StorageLike | null): string {
  if (remembered !== null) return remembered;
  try {
    const v = storage?.getItem(STORED_AS);
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

/** Whether a row's liquidity clears the minimum. A pool whose liquidity is unknown is below any minimum above zero. */
export function clearsMinLiquidity(liquidityUsd: number | null, min: string): boolean {
  const n = Number(min);
  if (!(n > 0)) return true;
  return liquidityUsd !== null && Number.isFinite(liquidityUsd) && liquidityUsd >= n;
}
