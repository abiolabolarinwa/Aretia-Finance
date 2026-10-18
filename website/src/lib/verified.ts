/**
 * "Verified by Aretia": what the badge means, how an entry is checked before it is shown, and how a token is looked up.
 * Pure: no network, no DOM. The list itself is src/data/verified.ts; the plain-words definition is website/docs/verified-badge.md.
 *
 * The badge is a record of four specific checks on one day. It is not an audit, not an endorsement and not investment advice, and it
 * says so wherever it is shown (see DEFINITION). An entry that fails any rule here is skipped, never shown half-formed.
 */

export type VerifyChain = 'solana' | 'bnb' | 'ethereum' | 'polygon';
export const VERIFY_CHAINS: readonly VerifyChain[] = ['solana', 'bnb', 'ethereum', 'polygon'];

/** The four checks. An entry is shown only when it records all four. */
export type CheckKey = 'supply-fixed' | 'powers-given-up' | 'identity-matches' | 'pool-locked';
export const CHECKS: readonly { key: CheckKey; label: string; how: string }[] = [
  { key: 'supply-fixed', label: 'The supply is fixed', how: 'No one can create more of the token. Read from the chain by the check script.' },
  { key: 'powers-given-up', label: 'Special powers are given up', how: 'On Solana, the mint and freeze authorities are gone and there is no transfer hook or permanent delegate. On Ethereum-style chains, the token code has no mint, pause or owner functions. Read from the chain by the check script.' },
  { key: 'identity-matches', label: 'The project link matches the claim', how: 'A person at Aretia checked that the project link and the creator named in the request are the ones the token points to. Recorded by hand.' },
  { key: 'pool-locked', label: 'A locked pool exists', how: 'A trading pool or curve for the token exists and its liquidity is locked. Checked on the chain and recorded by hand.' },
];

export interface VerifiedEntry {
  /** The token address. Solana addresses are case-sensitive; Ethereum-style ones are compared in lower case. */
  token: string;
  chain: VerifyChain;
  /** The day the checks were run, YYYY-MM-DD. */
  date: string;
  /** The checks the entry records. All four are required. */
  checked: readonly CheckKey[];
  /** An https link to the written evidence: the script's output, the explorer pages, the notes. */
  evidence: string;
  /** Optional, short: a name for the token to show beside the badge. */
  label?: string;
}

/** The sentence every badge carries. Shown in the tooltip and at the top of the dialog. */
export const SHORT_DEFINITION = 'Aretia checked four things on one day. This is not an audit, not an endorsement and not investment advice.';

export const DEFINITION = {
  title: 'Verified by Aretia',
  does: 'On the date shown, Aretia checked that the token’s supply is fixed, that its special powers (minting, freezing, pausing) are given up, that the project link and creator match what was claimed, and that a locked pool or curve exists.',
  doesNot: [
    'It is not a security audit of the token, the pool or the project.',
    'It is not an endorsement, and not investment advice.',
    'It does not say the price will hold, that the team is trustworthy, or that nothing can go wrong.',
    'It only describes the day it was checked. Anything can change after that.',
  ],
  paid: 'A request for verification does not buy the badge. Aretia can say no, and a check that fails is not hidden.',
} as const;

const MS_DAY = 86_400_000;
const day = (iso: string): number | null => (/^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) ? Date.parse(`${iso}T00:00:00Z`) : null);

export function httpsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname.includes('.') && !/^[\d.]+$/.test(u.hostname) && u.hostname !== 'localhost';
  } catch {
    return false;
  }
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;

/** Whether `address` is well formed for `chain`. */
export function addressOk(chain: string, address: string): boolean {
  if (chain === 'solana') return BASE58.test(address);
  if (chain === 'bnb' || chain === 'ethereum' || chain === 'polygon') return EVM.test(address);
  return false;
}

/** The form of an address used to compare two: Ethereum-style addresses ignore case, Solana ones do not. */
export const normalise = (chain: string, address: string): string => (chain === 'solana' ? address : address.toLowerCase());

/** Why an entry cannot be shown, or null when it is fine. */
export function problemWith(e: VerifiedEntry, now: number = Date.now()): string | null {
  if (!VERIFY_CHAINS.includes(e.chain)) return 'the chain is not one Aretia verifies';
  if (!addressOk(e.chain, e.token)) return 'the token address is not valid for its chain';
  const d = day(e.date);
  if (d === null) return 'the date is not YYYY-MM-DD';
  if (d > now + MS_DAY) return 'the date is in the future';
  if (!CHECKS.every((c) => e.checked.includes(c.key))) return 'not all four checks are recorded';
  if (!httpsUrl(e.evidence)) return 'the evidence link is not an https address';
  if (e.label !== undefined && (e.label.length === 0 || e.label.length > 40)) return 'the label must be 1 to 40 characters';
  return null;
}

/** The entry for a token, or null. An invalid entry never matches, and the latest valid entry for the same token wins. */
export function verifiedFor(list: readonly VerifiedEntry[], chain: string, token: string, now: number = Date.now()): VerifiedEntry | null {
  const want = normalise(chain, token);
  let found: VerifiedEntry | null = null;
  for (const e of list) {
    if (e.chain === chain && normalise(e.chain, e.token) === want && problemWith(e, now) === null && (found === null || e.date >= found.date)) found = e;
  }
  return found;
}

/** "18 Oct 2026" from YYYY-MM-DD, in English whatever the visitor's locale, so the badge reads the same everywhere. */
export function dateText(iso: string): string {
  const d = day(iso);
  if (d === null) return iso;
  const dt = new Date(d);
  return `${dt.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}
