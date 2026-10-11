/**
 * Address poisoning: a scammer makes an address that starts and ends like one you use (wallets show only the first and last
 * few characters), sends you a tiny amount so theirs appears in your history, and waits for you to copy the wrong one. This finds
 * addresses that look like a known one without being it.
 */
import type { KnownAddress } from './types.js';

/** Characters in common at the start, and at the end, of two strings. */
export function sharedEnds(a: string, b: string): { prefix: number; suffix: number } {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

const isEvm = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

/** What gets compared: an EVM address without its 0x and letter case; a Solana address exactly as it is. */
const body = (a: string): string => (isEvm(a) ? a.slice(2).toLowerCase() : a);

/** The least that must match at each end for two different addresses to count as look-alikes. */
export const LOOKALIKE_MIN_END = 3;

export interface Lookalike {
  known: KnownAddress;
  prefix: number;
  suffix: number;
}

/**
 * The known addresses this one imitates: not the same address, but matching at least three characters at the start AND at
 * the end. By chance that is a one-in-billions event for any one pair, so a hit means someone made it so. Strongest first.
 */
export function findLookalikes(address: string, known: readonly KnownAddress[]): Lookalike[] {
  const a = body(address);
  const out: Lookalike[] = [];
  for (const k of known) {
    // Only addresses of the same kind are compared: a Solana address never imitates an EVM one.
    if (isEvm(k.address) !== isEvm(address)) continue;
    const b = body(k.address);
    if (a === b) continue;
    const { prefix, suffix } = sharedEnds(a, b);
    if (prefix >= LOOKALIKE_MIN_END && suffix >= LOOKALIKE_MIN_END) out.push({ known: k, prefix, suffix });
  }
  return out.sort((x, y) => y.prefix + y.suffix - (x.prefix + x.suffix));
}

/** True when the same address is among the known ones. */
export const isKnown = (address: string, known: readonly KnownAddress[]): KnownAddress | null => known.find((k) => body(k.address) === body(address)) ?? null;
