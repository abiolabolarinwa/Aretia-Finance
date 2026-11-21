/**
 * "Can someone buy this right now?" for Solana tokens, answered from Aretia's own index and the chain, with no outside service.
 *
 * A token is listed as buyable only when:
 *  - its pool holds at least BUYABLE_MIN_LIQUIDITY_USD. Aretia's liquidity is twice the pool's SOL / dollar-coin side, read from the chain, so a
 *    worthless token cannot inflate it by pricing itself;
 *  - its mint has no FREEZE authority. With one, its issuer can lock a buyer's tokens and the buyer could not sell. Read from the token's mint
 *    account (the supply refresher records it). The chain's own quote tokens (USDC, USDT) are exempt: their issuers hold a freeze power by design;
 *  - the pool does not fail the wash-trading checks (far more volume than the pool could hold, many trades from a handful of accounts, a few
 *    accounts looping the pool's liquidity), the same checks the market figures use.
 *
 * What it does not judge: how the supply is held (a few wallets owning almost everything) and whether the token is a copy of another. Those
 * need a read of the token's largest accounts, which is not done here. A token whose mint was never read is NOT listed (unknown is not safe).
 */
import type { MarketRow } from '../../market/types.js';
import { fromMarketRow, suspicious } from '../../market/intel/common.js';

export const BUYABLE_MIN_LIQUIDITY_USD = 1_000;
/** Bit values of a token's `mint_flags`: set when the mint still has that authority. */
export const MINT_AUTHORITY = 1;
export const FREEZE_AUTHORITY = 2;

export const flagsOf = (mintAuthority: string | null, freezeAuthority: string | null): number => (mintAuthority ? MINT_AUTHORITY : 0) | (freezeAuthority ? FREEZE_AUTHORITY : 0);

export function ownBuyable(row: MarketRow, mintFlags: number | null | undefined, exempt: ReadonlySet<string>): boolean {
  if ((row.liquidityUsd ?? 0) < BUYABLE_MIN_LIQUIDITY_USD) return false;
  if (mintFlags === null || mintFlags === undefined) return false;
  if ((mintFlags & FREEZE_AUTHORITY) !== 0 && !exempt.has(row.address)) return false;
  const p = fromMarketRow(row);
  return !(p && suspicious(p));
}
