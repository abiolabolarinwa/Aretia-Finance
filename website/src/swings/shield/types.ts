/**
 * Aretia Shield: what a check returns. A verdict is a colour (the same five as the Aretia rating), a one-line answer in plain
 * words, the findings behind it, and what Shield could NOT see. Shield never says "safe": green means no problems were found
 * among the things it checked, and the list of what it could not check is always shown.
 */
import type { Band } from '../market/rowRisk.js';
import type { ChainId } from '../core/types.js';

export type { Band };

/** bad: a real problem. warn: a strong caution. note: worth knowing. ok: a check that passed. info: context, neither good nor bad. */
export type Severity = 'bad' | 'warn' | 'note' | 'ok' | 'info';

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
}

export type SubjectKind = 'solana-wallet' | 'solana-program' | 'solana-token' | 'solana-token-account' | 'evm-wallet' | 'evm-contract' | 'evm-token' | 'site' | 'unknown';

export interface Subject {
  kind: SubjectKind;
  /** Null for a site, and for an EVM address not tied to one network. */
  chain: ChainId | null;
  /** The address or the host name, as checked. */
  value: string;
  /** A name for it: a token's name and symbol, a program's name, a contact's label. Null when there is none. */
  label: string | null;
  icon: string | null;
  /** For a token: its decimal places and full name, when they could be read, so a swap can be opened from the result. */
  decimals?: number | null;
  name?: string | null;
}

export interface Fact {
  label: string;
  value: string;
}

export interface Verdict {
  subject: Subject;
  band: Band;
  /** One sentence a person can act on. */
  headline: string;
  findings: Finding[];
  /** What Shield could not look at, said plainly. Never counted as a pass. */
  couldNot: string[];
  facts: Fact[];
  /** Links to read more: a block explorer, the chart. */
  links: { label: string; url: string }[];
  checkedAt: number;
  /** For a token: the rating word ("Unverified", "High risk"), so the chip matches the Markets list. */
  ratingLabel?: string;
}

export const BAND_ORDER: readonly Band[] = ['green', 'yellow', 'orange', 'red'];

/** How bad a band is, so the worse of two can be picked. Grey (unknown) sits below yellow: it asserts nothing. */
export const bandRank = (b: Band): number => (b === 'grey' ? -1 : BAND_ORDER.indexOf(b));

export const worseBand = (a: Band, b: Band): Band => (bandRank(b) > bandRank(a) ? b : a);

export interface KnownAddress {
  /** Exactly as it is saved (Solana is case-sensitive; EVM is stored lower-case). */
  address: string;
  /** A name the person gave it, or null for an address they only sent to once. */
  label: string | null;
  /** Saved on purpose, as opposed to remembered because they sent something there. */
  trusted: boolean;
  lastUsed: number;
}
