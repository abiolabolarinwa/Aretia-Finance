/**
 * The settlement safety engine. It runs between "the user picked a quote" and "an execution is created", and it fails
 * closed: anything it cannot verify is a blocker, not a pass.
 *
 * Verdicts:
 *  - `block`: do not proceed; the reasons are shown;
 *  - `confirm`: allowed only if the user explicitly acknowledges each listed risk;
 *  - `allow`: nothing to flag (notes may still be shown).
 */
import { CHAINS } from '../core/types.js';
import type { ChainId } from '../core/types.js';
import type { SettlementProvider, SettlementQuote } from './types.js';
import type { ExecutionRecord } from '../orchestrator/states.js';
import { isFinal } from '../orchestrator/states.js';

export interface SafetyContext {
  now: number;
  provider: SettlementProvider | null;
  /** Networks the operator has switched on. A network missing here blocks. */
  enabledChains: readonly ChainId[];
  /** The sender's balance of the source asset, raw units. Null means it could not be read, which blocks. */
  sourceBalance: bigint | null;
  /**
   * The sender's balance of the source chain's own coin, which pays the network fee for the burn (and, on Solana, the deposit that
   * stores the message record). Optional: a caller that does not read it skips this check. Null means it could not be read.
   */
  sourceNativeBalance?: bigint | null;
  /** The recipient's balance of the destination chain's native coin, which pays for the claim. Null = could not be read. */
  destinationNativeBalance: bigint | null;
  /** Executions already saved, to stop the same move being started twice. */
  existing: readonly ExecutionRecord[];
  /** Largest amount (raw source units) allowed in one execution while Swings is being proven. Null = no cap configured, which blocks. */
  maxAmount: bigint | null;
  /** Largest settlement fee as basis points of the amount. */
  maxFeeBps?: number;
  /** Seconds a quote must still be valid for, so it does not lapse while the user is reading it. */
  minSecondsLeft?: number;
  /** The user explicitly chose a recipient other than their own account. */
  recipientIsDifferentOnPurpose?: boolean;
}

export interface SafetyVerdict {
  verdict: 'allow' | 'confirm' | 'block';
  blockers: string[];
  /** Risks the user must acknowledge one by one. */
  confirmations: string[];
  notes: string[];
}

const addressOk = (chain: ChainId, a: string): boolean => (CHAINS[chain].kind === 'evm' ? /^0x[0-9a-fA-F]{40}$/.test(a) : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a));
const RISK = { low: 0, medium: 1, high: 2 } as const;
/** Raw 6-decimal units as exact text (USDC), without importing the view layer. */
const fmt6 = (raw: bigint): string => {
  const t = raw.toString().padStart(7, '0');
  const frac = t.slice(-6).replace(/0+$/, '');
  return `${t.slice(0, -6)}${frac ? '.' + frac : ''}`;
};

/**
 * Below this much of the source chain's coin a burn is likely to fail or leave nothing for later. Solana's burn pays a fee and a
 * small deposit for the message record (a few thousandths of a SOL); 0.006 SOL is chosen to cover both with room. It is a
 * warning, not a block, and is to be checked against the first real Solana burn.
 */
export const LOW_SOURCE_NATIVE: Readonly<Partial<Record<ChainId, bigint>>> = { solana: 6_000_000n };

export function assessSettlement(q: SettlementQuote, c: SafetyContext): SafetyVerdict {
  const blockers: string[] = [];
  const confirmations: string[] = [];
  const notes: string[] = [];
  const { intent } = q;

  if (!c.provider || c.provider.id !== q.providerId) blockers.push('The provider for this quote is not available.');
  else if (c.provider.allowedDestinations(intent.sourceChain).length === 0 || c.provider.allowedDestinations(intent.destinationChain).length === 0) blockers.push('The provider has not declared the addresses it will call on both networks, so it cannot be checked.');

  for (const chain of [intent.sourceChain, intent.destinationChain]) if (!c.enabledChains.includes(chain)) blockers.push(`${CHAINS[chain].name} is not switched on for Swings.`);
  if (intent.sourceChain === intent.destinationChain) blockers.push('The source and destination are the same network.');
  if (!addressOk(intent.sourceChain, intent.sender)) blockers.push('The sending address is not valid for its network.');
  if (!addressOk(intent.destinationChain, intent.recipient)) blockers.push('The receiving address is not valid for its network.');

  if (intent.sender.toLowerCase() !== intent.recipient.toLowerCase() && CHAINS[intent.sourceChain].kind === CHAINS[intent.destinationChain].kind) {
    if (c.recipientIsDifferentOnPurpose) confirmations.push(`The funds will go to ${intent.recipient}, which is not your own account. Sending to the wrong address cannot be undone.`);
    else blockers.push('The receiving account is not the sending account, and you did not choose that.');
  }
  if (CHAINS[intent.sourceChain].kind !== CHAINS[intent.destinationChain].kind) confirmations.push('The receiving account is on a different kind of network from the sending one. Check the address belongs to you.');

  if (c.maxAmount === null) blockers.push('No limit per move is configured, so none is allowed.');
  else if (q.sourceAmount > c.maxAmount) blockers.push('This amount is above the limit for a single move while Swings is being proven.');

  const seconds = Math.floor((q.expiresAt - c.now) / 1000);
  if (seconds < (c.minSecondsLeft ?? 20)) blockers.push('The quote is about to expire. Get a new one.');
  if (RISK[q.risk.level] >= RISK.high) blockers.push('The provider rates this route as high risk.');
  else if (q.risk.level === 'medium') confirmations.push(`This route is rated medium risk: ${q.risk.trust}`);

  const maxBps = c.maxFeeBps ?? 100;
  const feeBps = q.sourceAmount > 0n ? Number((q.settlementFee.amount * 10_000n) / q.sourceAmount) : 10_000;
  if (feeBps > maxBps) blockers.push(`The transfer fee is ${(feeBps / 100).toFixed(2)}% of the amount, above the ${(maxBps / 100).toFixed(2)}% allowed.`);

  // The balance must cover everything that leaves it: with fees added on top (Circle CCTP) that is more than the amount entered.
  const total = q.sourceTotal ?? q.sourceAmount;
  if (q.sourceTotal !== undefined && q.sourceTotal < q.sourceAmount) blockers.push('The quote takes less than the amount, which cannot be right.');
  if (c.sourceBalance === null) blockers.push('Your balance on the sending network could not be read, so enough funds cannot be confirmed.');
  else if (c.sourceBalance < total) {
    if (total === q.sourceAmount) blockers.push('Your balance on the sending network is less than the amount.');
    else {
      const most = c.provider?.largestAmountFor?.(q, c.sourceBalance) ?? null;
      blockers.push(`Your balance on the sending network is less than the ${fmt6(total)} USDC this move needs (the amount plus the fees, which are added on top).${most !== null && most > 0n ? ` The most you can move with your balance is ${fmt6(most)} USDC.` : ''}`);
    }
  }

  if (c.sourceNativeBalance !== undefined) {
    const sym = CHAINS[intent.sourceChain].nativeSymbol;
    const srcName = CHAINS[intent.sourceChain].name;
    if (c.sourceNativeBalance === null) blockers.push(`Your ${sym} balance on ${srcName} could not be read, so the network fee for sending cannot be confirmed.`);
    else if (c.sourceNativeBalance === 0n) blockers.push(`You have no ${sym} on ${srcName} to pay the network fee, so the transfer cannot be sent.`);
    else if (LOW_SOURCE_NATIVE[intent.sourceChain] !== undefined && c.sourceNativeBalance < LOW_SOURCE_NATIVE[intent.sourceChain]!) confirmations.push(`You have very little ${sym} on ${srcName}. The transfer needs ${sym} for the network fee${intent.sourceChain === 'solana' ? ' and a small deposit for the message record' : ''}, and it may fail if there is not enough.`);
  }
  if (c.destinationNativeBalance === null) blockers.push(`Your ${CHAINS[intent.destinationChain].nativeSymbol} balance on ${CHAINS[intent.destinationChain].name} could not be read, so the claim fee cannot be confirmed.`);
  else if (c.destinationNativeBalance === 0n) confirmations.push(`You have no ${CHAINS[intent.destinationChain].nativeSymbol} on ${CHAINS[intent.destinationChain].name}. Without it you cannot claim the funds there, and they stay unclaimed until you add some.`);

  const duplicate = c.existing.find((r) => !isFinal(r.state) && r.quote.intent.sender.toLowerCase() === intent.sender.toLowerCase() && r.quote.intent.sourceChain === intent.sourceChain && r.quote.intent.destinationChain === intent.destinationChain && r.quote.intent.sourceAmount === intent.sourceAmount);
  if (duplicate) blockers.push('The same move is already in progress. Finish or check it first.');
  else if (c.existing.some((r) => !isFinal(r.state) && r.quote.intent.sender.toLowerCase() === intent.sender.toLowerCase())) notes.push('Another move from this account is still in progress.');

  if (q.networkFees === null) notes.push('Network fees were not estimated.');
  return { verdict: blockers.length > 0 ? 'block' : confirmations.length > 0 ? 'confirm' : 'allow', blockers, confirmations, notes };
}
