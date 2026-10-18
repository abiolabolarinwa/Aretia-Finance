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
  /** Fees already claimed over the position's life, from the pool program's own counters. Absent if they could not be read. */
  claimedA?: bigint;
  claimedB?: bigint;
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

// ---------------------------------------------------------------- the creator rewards headline

const LAMPORTS = 10n ** 9n;
export const SHARE_ORIGIN = 'https://aretiafinance.org';

/** SOL earned by one position: waiting to be claimed, and (when the program's counters were read) already claimed. Non-SOL fees are left out. */
export function positionSol(p: PoolPosition): { waiting: bigint; claimed: bigint | null } {
  const sides: [PoolSide, bigint, bigint | undefined][] = [[p.a, p.feeA, p.claimedA], [p.b, p.feeB, p.claimedB]];
  let waiting = 0n;
  let claimed: bigint | null = 0n;
  for (const [side, fee, done] of sides) {
    if (side.mint !== NATIVE_MINT) continue;
    waiting += fee;
    claimed = done === undefined || claimed === null ? null : claimed + done;
  }
  return { waiting, claimed };
}

/** The other tokens a position's fees are paid in, as "1,000 ALC" lines, for the things that are not converted. */
export function otherFees(p: PoolPosition): string[] {
  const out: string[] = [];
  if (p.a.mint !== NATIVE_MINT && p.feeA > 0n) out.push(`${amountText(p.feeA, p.a.decimals)} ${p.a.symbol}`);
  if (p.b.mint !== NATIVE_MINT && p.feeB > 0n) out.push(`${amountText(p.feeB, p.b.decimals)} ${p.b.symbol}`);
  return out;
}

export interface Rewards {
  /** SOL fees waiting to be claimed, in lamports. */
  waiting: bigint;
  /** SOL fees already claimed, or null if any listed pool's counter could not be read (then it is not counted at all). */
  claimed: bigint | null;
  /** What "You earned" adds up: waiting plus claimed, or waiting alone when claimed is unknown. */
  earned: bigint;
  /** Fees in other tokens, shown as they are, never converted. */
  other: string[];
}

export function rewardsFor(list: readonly PoolPosition[]): Rewards {
  let waiting = 0n;
  let claimed: bigint | null = 0n;
  const other: string[] = [];
  for (const p of list) {
    const s = positionSol(p);
    waiting += s.waiting;
    claimed = claimed === null || s.claimed === null ? null : claimed + s.claimed;
    other.push(...otherFees(p).map((t) => `${t} (${pairName(p)})`));
  }
  return { waiting, claimed, earned: waiting + (claimed ?? 0n), other };
}

/** SOL for people: up to four places, "under 0.0001" for dust, "0" for nothing. */
export const solText = (lamports: bigint): string => (lamports <= 0n ? '0' : lamports < LAMPORTS / 10_000n ? 'under 0.0001' : amountText(lamports, 9));

/** "$12.34" for a SOL amount at a USD price, or null with no usable price. */
export function usdText(lamports: bigint, solUsd: number | null): string | null {
  if (solUsd === null || !Number.isFinite(solUsd) || solUsd <= 0 || lamports <= 0n) return null;
  const usd = (Number(lamports) / 1e9) * solUsd;
  return usd < 0.01 ? 'under $0.01' : `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function headlineText(r: Rewards, solUsd: number | null): string {
  const usd = usdText(r.earned, solUsd);
  return `You earned ${solText(r.earned)} SOL${usd ? ` (about ${usd})` : ''}`;
}

/** The plain sentence under the headline saying exactly what the number is. */
export function headlineExplain(r: Rewards): string {
  const w = `${solText(r.waiting)} SOL waiting to be claimed`;
  if (r.claimed === null) return `This is only the ${w} now. Fees you have already claimed could not be read reliably, so they are not counted.`;
  return `${w}, plus ${solText(r.claimed)} SOL you have already claimed, from the pools listed below.`;
}

/** The token page for a pool's launched token (the side that is not SOL). Nothing private is in it: a public address only. */
export function shareLink(p: PoolPosition): string {
  const mint = p.a.mint === NATIVE_MINT ? p.b.mint : p.a.mint;
  return `${SHARE_ORIGIN}/token#/solana/${mint}`;
}

export function shareText(p: PoolPosition): string {
  const token = p.a.mint === NATIVE_MINT ? p.b.symbol : p.a.symbol;
  const s = positionSol(p);
  const x = s.waiting + (s.claimed ?? 0n);
  const ticker = /^[A-Za-z0-9]{1,12}$/.test(token) ? `$${token}` : 'my token';
  return s.claimed === null
    ? `I launched ${ticker} on Aretia and it has ${solText(x)} SOL in fees waiting for me`
    : `I launched ${ticker} on Aretia and it has earned ${solText(x)} SOL in fees`;
}

export function headlineShareText(r: Rewards): string {
  return `I have earned ${solText(r.earned)} SOL in trading fees from the tokens I launched on Aretia`;
}
