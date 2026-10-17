/**
 * "Your pools" on the Launch page: what a wallet owns in Meteora liquidity pools, how much it has earned in trading fees that it has
 * not claimed yet, and what can be claimed. Pure: no network, no keys.
 *
 * Aretia takes nothing when fees are claimed. A claim is a plain transaction of the pool program that pays the fees to the owner, so
 * anyone can also claim on Meteora's own site, and a charge here would only push people there. Aretia's income from pools is the flat
 * fee when a pool is opened (and, on Aretia Pool, the protocol share taken on every trade by the program itself).
 */
import { fromSmallestUnit } from './walletTools';

export const NATIVE_MINT = 'So11111111111111111111111111111111111111112';

export interface PoolSide {
  mint: string;
  /** The token program that owns the mint (the legacy Token program or Token-2022). */
  program: string;
  decimals: number;
  symbol: string;
  vault: string;
}

/** One liquidity position a wallet owns, with the numbers read from the chain. Amounts are in each token's smallest unit. */
export interface PoolPosition {
  pool: string;
  position: string;
  positionNft: string;
  positionNftAccount: string;
  a: PoolSide;
  b: PoolSide;
  /** Fees earned and not yet claimed. */
  feeA: bigint;
  feeB: bigint;
  /** Liquidity the owner can still remove, liquidity locked for good, and liquidity that is vesting. */
  unlocked: bigint;
  locked: bigint;
  vesting: bigint;
}

export const hasClaimable = (p: PoolPosition): boolean => p.feeA > 0n || p.feeB > 0n;

/** "ALC / SOL": the pair as people know it (the wrapped SOL mint is shown as SOL). */
export function pairName(p: PoolPosition): string {
  const name = (s: PoolSide): string => (s.mint === NATIVE_MINT ? 'SOL' : s.symbol);
  return `${name(p.a)} / ${name(p.b)}`;
}

export function lockText(p: PoolPosition): string {
  const total = p.unlocked + p.locked + p.vesting;
  if (total === 0n) return 'Empty';
  if (p.locked === total) return 'Locked for good';
  if (p.unlocked === total) return 'Not locked: you can remove it';
  return 'Partly locked';
}

/**
 * A token amount rounded for people: up to four decimal places, or six when it is under 0.001, with a leading "about" only where
 * rounding hid something. Zero is "0". Never the 18 digits the network stores.
 */
export function amountText(raw: bigint, decimals: number): string {
  if (raw <= 0n) return '0';
  const group = (text: string): string => {
    const [whole = '0', frac = ''] = text.split('.');
    const w = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return frac ? `${w}.${frac}` : w;
  };
  // Four decimal places normally, six for amounts under 0.001, and never more places than the token has.
  const wanted = raw >= 10n ** BigInt(Math.max(decimals - 3, 0)) ? 4 : 6;
  if (decimals <= wanted) return group(fromSmallestUnit(raw, decimals));
  const unit = 10n ** BigInt(decimals - wanted);
  const rounded = ((raw + unit / 2n) / unit) * unit;
  if (rounded === 0n) return `under ${group(fromSmallestUnit(unit, decimals))}`;
  const text = group(fromSmallestUnit(rounded, decimals));
  return rounded === raw ? text : `about ${text}`;
}

/** "ALC 1,000 and 0.0125 SOL": what a claim would pay, or "Nothing to claim yet". */
export function claimableText(p: PoolPosition): string {
  const parts: string[] = [];
  if (p.feeA > 0n) parts.push(`${amountText(p.feeA, p.a.decimals)} ${p.a.mint === NATIVE_MINT ? 'SOL' : p.a.symbol}`);
  if (p.feeB > 0n) parts.push(`${amountText(p.feeB, p.b.decimals)} ${p.b.mint === NATIVE_MINT ? 'SOL' : p.b.symbol}`);
  return parts.length === 0 ? 'Nothing to claim yet' : parts.join(' and ');
}

/** Pools with something to claim first, then by pair name, so the page opens on what matters. */
export function sortPositions(list: readonly PoolPosition[]): PoolPosition[] {
  return [...list].sort((x, y) => Number(hasClaimable(y)) - Number(hasClaimable(x)) || pairName(x).localeCompare(pairName(y)));
}
