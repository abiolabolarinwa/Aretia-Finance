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
  if (feeBps > maxBps) blockers.push(`The settlement fee is ${(feeBps / 100).toFixed(2)}% of the amount, above the ${(maxBps / 100).toFixed(2)}% allowed.`);

  if (c.sourceBalance === null) blockers.push('Your balance on the sending network could not be read, so enough funds cannot be confirmed.');
  else if (c.sourceBalance < q.sourceAmount) blockers.push('Your balance on the sending network is less than the amount.');

  if (c.destinationNativeBalance === null) blockers.push(`Your ${CHAINS[intent.destinationChain].nativeSymbol} balance on ${CHAINS[intent.destinationChain].name} could not be read, so the claim fee cannot be confirmed.`);
  else if (c.destinationNativeBalance === 0n) confirmations.push(`You have no ${CHAINS[intent.destinationChain].nativeSymbol} on ${CHAINS[intent.destinationChain].name}. Without it you cannot claim the funds there, and they stay unclaimed until you add some.`);

  const duplicate = c.existing.find((r) => !isFinal(r.state) && r.quote.intent.sender.toLowerCase() === intent.sender.toLowerCase() && r.quote.intent.sourceChain === intent.sourceChain && r.quote.intent.destinationChain === intent.destinationChain && r.quote.intent.sourceAmount === intent.sourceAmount);
  if (duplicate) blockers.push('The same move is already in progress. Finish or check it first.');
  else if (c.existing.some((r) => !isFinal(r.state) && r.quote.intent.sender.toLowerCase() === intent.sender.toLowerCase())) notes.push('Another move from this account is still in progress.');

  if (q.networkFees === null) notes.push('Network fees were not estimated.');
  return { verdict: blockers.length > 0 ? 'block' : confirmations.length > 0 ? 'confirm' : 'allow', blockers, confirmations, notes };
}
