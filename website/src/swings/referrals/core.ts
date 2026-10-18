/**
 * Referral rules, in one place and with no network, storage or clock of their own, so they can be tested and so the
 * owner can change them by editing the constants below. See docs/referrals.md.
 *
 * The money rule: a referrer earns a share of the fee Aretia actually received from a trader the referrer brought, for a
 * limited window. The share comes out of Aretia's fee, never on top of it, so a trader pays exactly what everyone pays.
 */
import { ARETIA_FEE_BPS } from '../core/fee.js';

export const REFERRAL_CONFIG = {
  /** The referrer's slice of Aretia's swap fee, in basis points of that fee (2000 = 20%). With the 0.58% fee this is about 0.116% of the trader's swap. */
  shareBps: 2000,
  /** How long a trader's swaps earn their referrer something, counted from the trader's first credited visit. */
  windowDays: 90,
  /** The most swaps credited to one referrer in 24 hours; more are recorded but earn nothing. */
  dailyCapPerReferrer: 200,
  /** The most swaps credited for one trader in 24 hours. */
  dailyCapPerTrader: 40,
  /** This many credits from one trader with the same asset and the same fee inside `washWindowMinutes` look like a script, not a person. */
  washRepeat: 6,
  washWindowMinutes: 10,
  /** A swap older than this when it is reported is not credited (a swap is reported seconds after it confirms). */
  maxTxAgeHours: 6,
  /** The owner pays out by hand, not below this many US dollars of value, on a schedule the owner sets. Shown on the page; not enforced by code. */
  minimumPayoutUsd: 25,
} as const;

export type ReferralConfig = { -readonly [K in keyof typeof REFERRAL_CONFIG]: number };

/** A referrer's share of one fee, rounded down in the smallest unit. */
export function shareOf(feeRaw: bigint, shareBps: number = REFERRAL_CONFIG.shareBps): bigint {
  if (feeRaw <= 0n || !Number.isInteger(shareBps) || shareBps <= 0 || shareBps > 10_000) return 0n;
  return (feeRaw * BigInt(shareBps)) / 10_000n;
}

/** The swap volume a fee implies (the fee is a fixed part of the amount paid), in the same asset. An estimate for display. */
export function impliedVolume(feeRaw: bigint): bigint {
  return (feeRaw * 10_000n) / BigInt(ARETIA_FEE_BPS);
}

/** The share of the amount traded the referrer earns, as a percent text for the screen, read from the two rates. */
export const referrerPercentOfVolume = (): string => `${((ARETIA_FEE_BPS * REFERRAL_CONFIG.shareBps) / 1_000_000).toFixed(3)}%`;

export const windowMs = (cfg: Pick<ReferralConfig, 'windowDays'> = REFERRAL_CONFIG): number => cfg.windowDays * 86_400_000;

/** Whether a binding made at `boundAt` still earns at `now`. */
export const inWindow = (boundAt: number, now: number, cfg: Pick<ReferralConfig, 'windowDays'> = REFERRAL_CONFIG): boolean => now >= boundAt && now < boundAt + windowMs(cfg);

// ------------------------------------------------------------------------------------------------ addresses

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;

export type Family = 'evm' | 'solana';

/** The referrer named by a link or a message, or null. EVM addresses are lower-cased; Solana addresses are kept as written. Nothing else is accepted. */
export function parseReferrer(value: unknown): { family: Family; address: string; owner: string } | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (EVM.test(v)) return { family: 'evm', address: v.toLowerCase(), owner: `evm:${v.toLowerCase()}` };
  if (B58.test(v)) return { family: 'solana', address: v, owner: `solana:${v}` };
  return null;
}

/** Same person on the same address. Different families can never be equal. */
export const isSelf = (traderOwner: string, referrerOwner: string): boolean => traderOwner.toLowerCase() === referrerOwner.toLowerCase();

// ------------------------------------------------------------------------------------------------ deciding

export type CreditStatus = 'credited' | 'capped' | 'flagged' | 'family';

export interface PriorCredit {
  referrer: string;
  trader: string;
  asset: string;
  feeRaw: bigint;
  at: number;
  status: CreditStatus;
}

/**
 * What to do with a verified fee payment. `recent` is the credits already stored for the last 24 hours that involve this referrer
 * or this trader. Nothing is dropped silently: a swap that earns nothing is still stored, with the reason, so the referrer can see
 * it and the owner can audit it.
 */
export function decideCredit(
  input: { referrer: string; trader: string; asset: string; feeRaw: bigint; at: number; chainFamily: Family; referrerFamily: Family },
  recent: PriorCredit[],
  cfg: ReferralConfig = REFERRAL_CONFIG,
): { status: CreditStatus; shareRaw: bigint } {
  if (input.chainFamily !== input.referrerFamily) return { status: 'family', shareRaw: 0n };
  const day = recent.filter((c) => input.at - c.at < 86_400_000 && c.at <= input.at + 60_000);
  const paid = day.filter((c) => c.status === 'credited');
  if (paid.filter((c) => c.referrer === input.referrer).length >= cfg.dailyCapPerReferrer) return { status: 'capped', shareRaw: 0n };
  if (paid.filter((c) => c.trader === input.trader).length >= cfg.dailyCapPerTrader) return { status: 'capped', shareRaw: 0n };
  const burst = day.filter((c) => c.trader === input.trader && c.asset === input.asset && c.feeRaw === input.feeRaw && input.at - c.at < cfg.washWindowMinutes * 60_000);
  if (burst.length >= cfg.washRepeat - 1) return { status: 'flagged', shareRaw: 0n };
  return { status: 'credited', shareRaw: shareOf(input.feeRaw, cfg.shareBps) };
}

/**
 * Two people naming each other: A's link brought B and B's link brought A. Each would be paid back part of their own fee, so the
 * second binding is refused. (Longer loops are not detected cheaply; the share comes out of the fee they pay, so a loop costs more
 * than it returns, and the owner can revoke.)
 */
export const isMutual = (traderOwner: string, referrerOwner: string, existing: { trader: string; referrer: string }[]): boolean =>
  existing.some((b) => b.trader === referrerOwner && b.referrer === traderOwner);

// ------------------------------------------------------------------------------------------------ totals

export interface CreditRow {
  chain: string;
  asset: string;
  status: CreditStatus;
  feeRaw: bigint;
  shareRaw: bigint;
  trader: string;
}

export interface Total {
  chain: string;
  asset: string;
  swaps: number;
  feeRaw: bigint;
  volumeRaw: bigint;
  owedRaw: bigint;
}

/** Totals per chain and coin of what a referrer is owed. Only `credited` rows count. */
export function totalsByChainAsset(rows: CreditRow[]): Total[] {
  const map = new Map<string, Total>();
  for (const r of rows) {
    if (r.status !== 'credited') continue;
    const k = `${r.chain}|${r.asset}`;
    const t = map.get(k) ?? { chain: r.chain, asset: r.asset, swaps: 0, feeRaw: 0n, volumeRaw: 0n, owedRaw: 0n };
    t.swaps += 1;
    t.feeRaw += r.feeRaw;
    t.volumeRaw += impliedVolume(r.feeRaw);
    t.owedRaw += r.shareRaw;
    map.set(k, t);
  }
  return [...map.values()].sort((a, b) => (a.chain + a.asset).localeCompare(b.chain + b.asset));
}

// ------------------------------------------------------------------------------------------------ the visitor's side

export const REF_STORAGE_KEY = 'aretia-referrer-v1';

export interface StoredRef {
  ref: string;
  at: number;
  expiresAt: number;
}

export interface KeyValue {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** The stored first-touch referrer, if there is one and it has not expired. */
export function readStoredRef(store: KeyValue | null, now: number): StoredRef | null {
  try {
    const raw = store?.getItem(REF_STORAGE_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<StoredRef>) : null;
    if (v && typeof v.ref === 'string' && typeof v.at === 'number' && typeof v.expiresAt === 'number' && v.expiresAt > now && parseReferrer(v.ref)) return v as StoredRef;
  } catch {
    // unreadable: treated as none
  }
  return null;
}

/**
 * Looks at the page address for `?ref=`. First touch wins: a valid, unexpired stored referrer is never replaced. Only the address is
 * stored, with the time; nothing else about the visitor. Returns what is stored afterwards.
 */
export function captureFromSearch(search: string, store: KeyValue | null, now: number, cfg: Pick<ReferralConfig, 'windowDays'> = REFERRAL_CONFIG): StoredRef | null {
  const existing = readStoredRef(store, now);
  if (existing) return existing;
  const ref = parseReferrer(new URLSearchParams(search).get('ref'));
  if (!ref) return null;
  const value: StoredRef = { ref: ref.address, at: now, expiresAt: now + windowMs(cfg) };
  try {
    store?.setItem(REF_STORAGE_KEY, JSON.stringify(value));
  } catch {
    return null;
  }
  return value;
}

/** The link a referrer shares. */
export const referralLink = (address: string, origin = 'https://aretiafinance.org'): string => `${origin}/?ref=${encodeURIComponent(address)}`;
