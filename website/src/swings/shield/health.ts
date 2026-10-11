/**
 * Wallet health: what is wrong or risky in a Solana wallet, found from its own token accounts. It reads, explains, and offers the
 * two safe fixes that exist: take back a permission you gave another address (revoke), and close empty token accounts to get
 * their rent back (reclaim). Nothing is done without the wallet's own approval.
 */
import { bandFromFindings } from './verdict.js';
import type { Band, Finding } from './types.js';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** SOL kept in a token account to keep it open: about 0.00204 SOL for an ordinary one. */
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280n;

export interface TokenAccount {
  address: string;
  mint: string;
  /** Which token program owns it: the account needs it to be revoked or closed. */
  program: string;
  amount: bigint;
  decimals: number;
  uiAmount: number;
  /** An address allowed to move this token without asking again, and how much of it. */
  delegate: string | null;
  delegatedAmount: bigint;
  frozen: boolean;
  lamports: bigint;
}

interface RawTokenAccount {
  pubkey: string;
  account: { lamports?: number; data?: { parsed?: { info?: { mint?: string; delegate?: string; state?: string; tokenAmount?: { amount?: string; decimals?: number; uiAmount?: number | null }; delegatedAmount?: { amount?: string } } } } };
}

/** Reads the token accounts of a wallet from both token programs. */
export async function readTokenAccounts(owner: string, sol: <T>(method: string, params: unknown[]) => Promise<T>): Promise<TokenAccount[]> {
  const out: TokenAccount[] = [];
  for (const program of [TOKEN_PROGRAM, TOKEN_2022_PROGRAM]) {
    const res = await sol<{ value?: RawTokenAccount[] }>('getTokenAccountsByOwner', [owner, { programId: program }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    for (const a of res.value ?? []) {
      const info = a.account?.data?.parsed?.info;
      const amount = info?.tokenAmount?.amount;
      if (!info || typeof info.mint !== 'string' || typeof amount !== 'string' || !/^\d+$/.test(amount)) continue;
      const delegated = info.delegatedAmount?.amount;
      out.push({
        address: a.pubkey,
        mint: info.mint,
        program,
        amount: BigInt(amount),
        decimals: info.tokenAmount?.decimals ?? 0,
        uiAmount: info.tokenAmount?.uiAmount ?? 0,
        delegate: typeof info.delegate === 'string' ? info.delegate : null,
        delegatedAmount: typeof delegated === 'string' && /^\d+$/.test(delegated) ? BigInt(delegated) : 0n,
        frozen: info.state === 'frozen',
        lamports: BigInt(a.account?.lamports ?? 0),
      });
    }
  }
  return out;
}

/** How one held token looked when Shield checked it. */
export interface HeldTokenCheck {
  mint: string;
  symbol: string | null;
  band: Band;
  ratingLabel: string | null;
  /** No trading pool was found: probably an airdropped spam token. */
  noMarket: boolean;
}

export interface HealthAction {
  kind: 'revoke' | 'reclaim' | 'check';
  /** The token accounts a revoke or a reclaim would touch. */
  accounts?: TokenAccount[];
  /** A token to open in Shield. */
  value?: string;
}

export interface HealthItem extends Finding {
  action?: HealthAction;
}

export interface HealthReport {
  band: Band;
  headline: string;
  items: HealthItem[];
  /** What closing every empty account would give back, in lamports. */
  reclaimLamports: bigint;
  tokenCount: number;
  checkedTokens: number;
  couldNot: string[];
}

const short = (v: string): string => (v.length > 12 ? `${v.slice(0, 5)}…${v.slice(-4)}` : v);
const sol = (lamports: bigint): string => (Number(lamports) / 1e9).toFixed(4);

/** An empty account can be closed when nothing is in it and it is not frozen or delegated. */
export const isReclaimable = (a: TokenAccount): boolean => a.amount === 0n && !a.frozen && a.delegate === null && a.program === TOKEN_PROGRAM;

/** Pure: turns the accounts, the SOL balance and what Shield found about each held token into a plain report. */
export function analyseWallet(input: { lamports: bigint; accounts: readonly TokenAccount[]; checks: readonly HeldTokenCheck[]; skipped: number }): HealthReport {
  const items: HealthItem[] = [];
  const bySymbol = new Map(input.checks.map((c) => [c.mint, c]));
  const name = (mint: string): string => bySymbol.get(mint)?.symbol ?? short(mint);

  // 1. Permissions given to other addresses.
  const delegated = input.accounts.filter((a) => a.delegate !== null && a.delegatedAmount > 0n);
  for (const a of delegated) {
    const all = a.delegatedAmount >= a.amount;
    items.push({
      id: `delegate-${a.address}`,
      severity: 'warn',
      title: `${short(a.delegate!)} can move ${all ? 'all of your' : 'up to'} ${(Number(a.delegatedAmount) / 10 ** a.decimals).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${name(a.mint)} without asking.`,
      detail: 'You gave this address a standing permission over this token. Some apps do this on purpose; a drainer does it to empty you later. If you do not recognise it, take it back.',
      action: { kind: 'revoke', accounts: [a] },
    });
  }
  if (delegated.length === 0) items.push({ id: 'no-delegates', severity: 'ok', title: 'No other address has permission to move your tokens.', detail: `Shield looked at ${input.accounts.length} token account${input.accounts.length === 1 ? '' : 's'}.` });

  // 2. Tokens that look risky.
  for (const c of input.checks) {
    const held = input.accounts.some((a) => a.mint === c.mint && a.amount > 0n);
    if (!held) continue;
    if (c.band === 'red') items.push({ id: `risk-${c.mint}`, severity: 'bad', title: `${name(c.mint)} is rated ${c.ratingLabel ?? 'high risk'}.`, detail: 'Shield found serious concerns with this token. Do not swap into it, do not approve anything it asks for, and be careful opening links in its name.', action: { kind: 'check', value: c.mint } });
    else if (c.band === 'orange') items.push({ id: `risk-${c.mint}`, severity: 'warn', title: `${name(c.mint)} is rated ${c.ratingLabel ?? 'elevated risk'}.`, detail: 'Shield found concerns with this token. Read them before you trade it.', action: { kind: 'check', value: c.mint } });
  }
  const spam = input.checks.filter((c) => c.noMarket && input.accounts.some((a) => a.mint === c.mint && a.amount > 0n));
  if (spam.length > 0) items.push({ id: 'no-market', severity: 'note', title: `${spam.length} token${spam.length === 1 ? ' has' : 's have'} no market at all.`, detail: `${spam.map((s) => name(s.mint)).slice(0, 6).join(', ')}${spam.length > 6 ? ' and more' : ''}. A token that appears in your wallet with nowhere to sell it is almost always an airdropped spam token. Ignore it, and never click a link in its name.` });

  // 3. Frozen accounts.
  const frozen = input.accounts.filter((a) => a.frozen && a.amount > 0n);
  if (frozen.length > 0) items.push({ id: 'frozen', severity: 'note', title: `${frozen.length} token account${frozen.length === 1 ? ' is' : 's are'} frozen.`, detail: `The token's creator froze ${frozen.map((a) => name(a.mint)).slice(0, 4).join(', ')}, so you cannot move or sell it.` });

  // 4. Rent you can take back.
  const empty = input.accounts.filter(isReclaimable);
  const reclaim = empty.reduce((n, a) => n + (a.lamports > 0n ? a.lamports : TOKEN_ACCOUNT_RENT_LAMPORTS), 0n);
  if (empty.length > 0) items.push({ id: 'reclaim', severity: 'note', title: `${empty.length} empty token account${empty.length === 1 ? '' : 's'} hold${empty.length === 1 ? 's' : ''} about ${sol(reclaim)} SOL you can get back.`, detail: 'Each token account keeps a small deposit of SOL. Closing the empty ones returns it. It is safe: an account with nothing in it can always be opened again.', action: { kind: 'reclaim', accounts: empty } });

  // 5. Fuel.
  if (input.lamports < 3_000_000n) items.push({ id: 'low-sol', severity: 'note', title: 'Very little SOL left.', detail: `${sol(input.lamports)} SOL may not cover the fee for your next transaction. Keep a little SOL in the wallet.` });

  const findings: Finding[] = items;
  const band = bandFromFindings(findings);
  const issues = items.filter((i) => i.severity === 'bad' || i.severity === 'warn' || i.severity === 'note').length;
  const worst = items.find((i) => i.severity === 'bad') ?? items.find((i) => i.severity === 'warn');
  const headline = band === 'green' ? 'No problems found in what Shield could check.' : issues === 1 ? `1 thing to look at. ${(worst ?? items.find((i) => i.severity === 'note'))!.title}` : `${issues} things to look at. ${(worst ?? items.find((i) => i.severity === 'note'))!.title}`;
  const couldNot = ['Approvals on other networks: this scan covers Solana. Check an Ethereum-style address in the EVM scan.', 'Whether a site you connected to earlier is still trusted: Solana keeps no list of connected sites.'];
  if (input.skipped > 0) couldNot.push(`${input.skipped} smaller token${input.skipped === 1 ? '' : 's'} were not rated, to keep the scan quick.`);
  return { band, headline, items: items.sort((a, b) => order(a) - order(b)), reclaimLamports: reclaim, tokenCount: input.accounts.filter((a) => a.amount > 0n).length, checkedTokens: input.checks.length, couldNot };
}

const order = (i: Finding): number => ({ bad: 0, warn: 1, note: 2, info: 3, ok: 4 })[i.severity];

// ------------------------------------------------------------------ the instructions

/** SPL Token "Revoke": instruction 5. Accounts: the token account (writable), then its owner (signer). */
export const REVOKE_DATA = Uint8Array.of(5);
/** SPL Token "CloseAccount": instruction 9. Accounts: the account, where its rent goes, and its owner (signer). */
export const CLOSE_ACCOUNT_DATA = Uint8Array.of(9);

/** At most this many accounts go in one transaction, so it stays well under the size limit. */
export const CLOSE_PER_TRANSACTION = 12;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
