/**
 * Faster trading: amounts a trader can tap in one go, and the slippage they chose last time, kept in this browser.
 * Nothing here signs or sends anything: a tap only fills the amount box, and every swap still goes through the review screen.
 */
import type { StorageLike } from '../swings/history.js';
import type { ChainId } from '../swings/core/types.js';
import { SLIPPAGE_PRESETS_BPS, toSmallestUnit } from './walletTools';

/** Round amounts of each network's own coin, from a small test to a normal trade. */
const NATIVE_AMOUNTS: Readonly<Record<ChainId, readonly string[]>> = {
  solana: ['0.1', '0.5', '1'],
  ethereum: ['0.01', '0.05', '0.1'],
  base: ['0.01', '0.05', '0.1'],
  robinhood: ['0.01', '0.05', '0.1'],
  bnb: ['0.05', '0.1', '0.5'],
  polygon: ['10', '50', '100'],
};
const DOLLAR_AMOUNTS = ['10', '50', '100'] as const;
const DOLLARS = new Set(['USDC', 'USDT', 'USDC.E', 'DAI', 'USD1', 'PYUSD', 'FDUSD']);

/** The one-tap amounts for paying with this token: the network's coin or a dollar stablecoin. Anything else gets none. */
export function quickAmountsFor(chain: ChainId, symbol: string, isNative: boolean): readonly string[] {
  if (isNative) return NATIVE_AMOUNTS[chain] ?? [];
  return DOLLARS.has(symbol.trim().toUpperCase()) ? DOLLAR_AMOUNTS : [];
}

/** True when the balance (smallest units) covers the amount. An unknown balance never blocks a tap. */
export function canAfford(amount: string, decimals: number, balance: bigint | null): boolean {
  if (balance === null) return true;
  const raw = toSmallestUnit(amount, decimals);
  return raw !== null && BigInt(raw) <= balance;
}

const SLIPPAGE_KEY = 'aretia.swap.slippageBps';

/** The slippage this person chose last time, or null when none was chosen (or it is no longer one of the choices). */
export function loadSlippage(storage: StorageLike | null): number | null {
  try {
    const n = Number(storage?.getItem(SLIPPAGE_KEY));
    return (SLIPPAGE_PRESETS_BPS as readonly number[]).includes(n) ? n : null;
  } catch {
    return null;
  }
}

/** Keeps the chosen slippage for the next visit. Never throws: storage may be blocked or full. */
export function saveSlippage(storage: StorageLike | null, bps: number): void {
  try {
    if ((SLIPPAGE_PRESETS_BPS as readonly number[]).includes(bps)) storage?.setItem(SLIPPAGE_KEY, String(bps));
  } catch {
    // not kept
  }
}
