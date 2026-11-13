/**
 * Which tokens in a wallet were probably sent to it, not chosen. Anyone can send any token to any address for free, and scammers do:
 * the same dust of a copycat token ("Trump Meme", "ElonMusk MEME") lands in thousands of wallets, with a made-up price from a pool that
 * holds almost nothing, hoping its owner will swap or "claim" on a scam site. Wallets such as MetaMask hide these; Aretia lists
 * everything the chain says the address holds, so it has to tell them apart.
 *
 * A token is tagged when its signs add up to two or more. A balance that is a whole number of tokens is enough on its own: a purchase on an
 * exchange is for an amount of money, so it gives a fractional number of tokens, while a mass airdrop sends 100 or 9 or 5. Nothing here proves
 * a token is a scam, and the person can always say "it is mine": the aim is only that such a token is not counted in the portfolio value, and
 * does not get a Buy or Sell button, until they ask.
 */
import type { ChainId } from '../swings/core/types.js';
import { impersonationWarning } from '../swings/tokens/impersonation.js';

export const AIRDROP_SCORE = 2;

/** Names that carry a link or an invitation: a real token name does not. */
const SPAMMY = /discord|telegram|t\.me\b|https?:|www\.|\.(com|gg|io|xyz|org|net|app|site|top|vip|cc|me)\b|\bclaim\b|airdrop|voucher|reward|visit\b|bonus|giveaway/i;

export interface AirdropCheck {
  chain: ChainId;
  address: string;
  symbol: string;
  name: string;
  amount: number;
  /** The exact balance in the smallest unit (a decimal string), when known. */
  raw: string | null;
  decimals: number | null;
  /** The only pool behind the price holds under $10,000 (or none is priced). */
  thin: boolean;
}

export type AirdropReason = 'spam-name' | 'imitates' | 'shallow-pool' | 'round-amount';

const WEIGHT: Readonly<Record<AirdropReason, number>> = { 'spam-name': 2, imitates: 2, 'shallow-pool': 1, 'round-amount': 2 };

export const REASON_TEXT: Readonly<Record<AirdropReason, string>> = {
  'spam-name': 'its name carries a link or an invitation',
  imitates: 'its name copies a well-known token',
  'shallow-pool': 'the only pool behind its price holds very little',
  'round-amount': 'the balance is a whole number of tokens, which a purchase seldom gives and a mass airdrop always does',
};

/** Whether the balance is a whole number of tokens (5, 100), which a purchase seldom is. */
function wholeAmount(c: Pick<AirdropCheck, 'amount' | 'raw' | 'decimals'>): boolean {
  if (!(c.amount > 0)) return false;
  if (c.raw !== null && c.decimals !== null && /^\d+$/.test(c.raw) && c.decimals >= 0 && c.decimals <= 36) return BigInt(c.raw) % 10n ** BigInt(c.decimals) === 0n;
  return Number.isInteger(c.amount);
}

export function airdropReasons(c: AirdropCheck): AirdropReason[] {
  const out: AirdropReason[] = [];
  if (SPAMMY.test(`${c.symbol} ${c.name}`)) out.push('spam-name');
  if (impersonationWarning(c.chain, c.address, c.symbol, c.name)) out.push('imitates');
  if (c.thin) out.push('shallow-pool');
  if (wholeAmount(c)) out.push('round-amount');
  return out;
}

/** Whether the signs add up to "probably sent, not chosen". */
export function looksLikeAirdrop(c: AirdropCheck): boolean {
  return airdropReasons(c).reduce((sum, r) => sum + WEIGHT[r], 0) >= AIRDROP_SCORE;
}

/** One sentence for the tag's tooltip. */
export function airdropExplanation(reasons: readonly AirdropReason[]): string {
  return reasons.length === 0 ? 'Probably sent to this wallet, not chosen.' : `Probably sent to this wallet, not chosen: ${reasons.map((r) => REASON_TEXT[r]).join('; ')}.`;
}

// ---------------------------------------------------------------- "it is mine"

const MINE_KEY = 'aretia-my-tokens-v1';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const keyOf = (chain: string, address: string): string => `${chain}:${address.toLowerCase()}`;

/** The tokens the person said are theirs, as `chain:address`. */
export function loadMine(storage: StorageLike | null): Set<string> {
  try {
    const raw = storage?.getItem(MINE_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && /^[a-z0-9]+:0x[0-9a-f]{40}$/.test(x)).slice(0, 500) : []);
  } catch {
    return new Set();
  }
}

export function markMine(storage: StorageLike | null, chain: string, address: string): Set<string> {
  const set = loadMine(storage);
  set.add(keyOf(chain, address));
  try {
    storage?.setItem(MINE_KEY, JSON.stringify([...set].slice(-500)));
  } catch {
    // Not remembered; the choice lasts until the page is closed.
  }
  return set;
}

export const isMine = (mine: ReadonlySet<string>, chain: string, address: string): boolean => mine.has(keyOf(chain, address));
