/**
 * What the cross-chain screen says, as plain data. Kept apart from the page so every word the user is shown about money
 * can be tested: amounts are exact (no floating point), fees are shown one by one and never merged into a vague total,
 * and a status never says "done" before the destination has the funds.
 */
import { CHAINS, SwingsError, type ChainId } from '../core/types.js';
import type { ExecutionRecord } from '../orchestrator/states.js';
import type { SettlementIntent, SettlementQuote } from '../settlement/types.js';

/** Raw units as exact text: 1234500 with 6 decimals is "1.2345". Never rounds. */
export function formatUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
}

/** Typed text to raw units, or null if it is not a plain non-negative decimal with at most `decimals` places. */
export function parseUnits(text: string, decimals: number): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(t)) return null;
  const [w = '0', f = ''] = t.split('.');
  if (f.length > decimals) return null;
  return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, '0') || '0');
}

export function durationText(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} seconds`;
  if (seconds < 90 * 60) return `about ${Math.round(seconds / 60)} minutes`;
  return `about ${(seconds / 3600).toFixed(1)} hours`;
}

export interface QuoteView {
  provider: string;
  mechanism: string;
  youSend: string;
  youReceive: string;
  /** Each cost on its own line, in its own asset. */
  fees: { label: string; value: string }[];
  time: string;
  steps: { text: string; chain: string; needsSignature: boolean }[];
  trust: string;
  risks: string[];
  requirements: string[];
  secondsLeft: number;
}

const USDC_DECIMALS = 6;

export function viewQuote(q: SettlementQuote, now: number, decimals = USDC_DECIMALS, symbol = 'USDC'): QuoteView {
  const src = CHAINS[q.intent.sourceChain].name;
  const dst = CHAINS[q.intent.destinationChain].name;
  const fees = [
    { label: 'Transfer fee', value: q.settlementFee.amount === 0n ? 'None' : `${formatUnits(q.settlementFee.amount, decimals)} ${symbol}` },
    ...(q.networkFees ?? []).map((f) => ({ label: `Network fee on ${CHAINS[f.chain].name}`, value: `${formatUnits(f.amount, CHAINS[f.chain].nativeDecimals ?? 18)} ${CHAINS[f.chain].nativeSymbol}` })),
    ...(q.networkFees === null ? [{ label: 'Network fees', value: `Not estimated. You pay them in ${CHAINS[q.intent.sourceChain].nativeSymbol} on ${src} and ${CHAINS[q.intent.destinationChain].nativeSymbol} on ${dst}.` }] : []),
  ];
  return {
    provider: q.providerId,
    mechanism: q.route.mechanism,
    youSend: `${formatUnits(q.sourceAmount, decimals)} ${symbol} on ${src}`,
    youReceive: `${formatUnits(q.destinationAmount, decimals)} ${symbol} on ${dst}`,
    fees,
    time: durationText(q.estimatedSeconds),
    steps: q.route.steps.map((s) => ({ text: s.description, chain: CHAINS[s.chain].name, needsSignature: s.requiresSignature })),
    trust: q.risk.trust,
    risks: q.risk.factors,
    requirements: q.requirements,
    secondsLeft: Math.max(0, Math.floor((q.expiresAt - now) / 1000)),
  };
}

export type Tone = 'progress' | 'ok' | 'warn' | 'bad';
export type NextAction = 'sign' | 'wait' | 'claim' | 'check-wallet' | 'none';

export interface StatusView {
  title: string;
  detail: string;
  tone: Tone;
  next: NextAction;
}

/** How long the wait usually is, and that closing the page is safe: the move is saved and picked up again on return. */
function keepNote(r: ExecutionRecord): string {
  const usually = r.quote.estimatedSeconds > 0 ? `This usually takes ${durationText(r.quote.estimatedSeconds)}. ` : '';
  return `${usually}You can close this page: the move is saved in this browser, and Pay > Move USDC picks it up again so you can finish it.`;
}

/** What to tell the user about an execution right now. The funds are described as arrived only in COMPLETED. */
export function viewStatus(r: ExecutionRecord, claimable: boolean): StatusView {
  const dst = CHAINS[r.quote.intent.destinationChain].name;
  const src = CHAINS[r.quote.intent.sourceChain].name;
  if (r.needsAttention) return { title: 'Check your wallet', detail: r.needsAttention, tone: 'warn', next: 'check-wallet' };
  switch (r.state) {
    case 'CREATED':
    case 'QUOTED':
      return { title: 'Ready to start', detail: 'Nothing has been signed yet.', tone: 'progress', next: 'sign' };
    case 'AWAITING_SIGNATURE':
      return { title: 'Waiting for your signature', detail: 'Approve in your wallet. Check the amount and network it shows.', tone: 'progress', next: 'sign' };
    case 'SOURCE_SUBMITTED':
      return { title: `Sent on ${src}`, detail: `Waiting for the network to confirm. The funds have not arrived yet. ${keepNote(r)}`, tone: 'progress', next: 'wait' };
    case 'SOURCE_CONFIRMED':
    case 'SETTLEMENT_PENDING':
      return claimable
        ? { title: `Ready to claim on ${dst}`, detail: `The funds are released. Claim them with your wallet on ${dst}; you need a little ${CHAINS[r.quote.intent.destinationChain].nativeSymbol} for the fee. Until you claim, they are not in your ${dst} account.`, tone: 'warn', next: 'claim' }
        : { title: `Moving to ${dst}`, detail: r.steps['mint'] ? 'Your claim was sent. Waiting for it to confirm.' : `Sent and confirmed on the first network. Waiting for the settlement. The funds have not arrived yet. ${keepNote(r)}`, tone: 'progress', next: 'wait' };
    case 'DESTINATION_RECEIVED':
    case 'DESTINATION_EXECUTED':
      return { title: 'Arrived', detail: `The funds reached ${dst}. Finishing up.`, tone: 'progress', next: 'wait' };
    case 'COMPLETED':
      return { title: 'Complete', detail: `The funds are in your ${dst} account.`, tone: 'ok', next: 'none' };
    case 'EXPIRED':
      return { title: 'Quote expired', detail: 'Nothing was sent. Get a new quote.', tone: 'warn', next: 'none' };
    case 'REFUNDED':
      return { title: 'Refunded', detail: `Your funds were returned${r.refundTxHash ? ` (${r.refundTxHash})` : ''}.`, tone: 'warn', next: 'none' };
    case 'FAILED':
      return { title: 'Did not complete', detail: r.failure ? `${r.failure.reason}${r.failure.fundsMayBeAtRisk ? ' Your funds may be in transit: keep the transaction hashes and do not retry until you have checked.' : ' No funds were moved by this step.'}` : 'It failed.', tone: 'bad', next: 'none' };
  }
}

/** The unfinished move that belongs to one of the connected accounts, if any (the first one found). */
export function pickUnfinished(list: readonly ExecutionRecord[], accounts: readonly (string | null)[]): ExecutionRecord | null {
  const mine = new Set(accounts.filter((a): a is string => !!a).map((a) => a.toLowerCase()));
  return list.find((r) => mine.has(r.quote.intent.sender.toLowerCase())) ?? null;
}

/**
 * Who a move is from and to, against the accounts connected on this page. The sender must be the wallet connected for the
 * source network, or nothing may be signed. A recipient that is not the account connected for the destination is allowed
 * only after the person has seen the full address and confirmed it (`confirmRecipient` holds that question).
 */
export function checkParties(intent: SettlementIntent, accountFor: (chain: ChainId) => string | null): { error: string | null; confirmRecipient: string | null } {
  const same = (chain: ChainId, a: string, b: string | null): boolean => b !== null && (CHAINS[chain].kind === 'evm' ? a.toLowerCase() === b.toLowerCase() : a === b);
  const src = CHAINS[intent.sourceChain].name;
  const dst = CHAINS[intent.destinationChain].name;
  if (!same(intent.sourceChain, intent.sender, accountFor(intent.sourceChain))) return { error: `This move is from ${intent.sender}, which is not the wallet connected for ${src}. Nothing was signed. Get a new quote with your connected wallet.`, confirmRecipient: null };
  if (same(intent.destinationChain, intent.recipient, accountFor(intent.destinationChain))) return { error: null, confirmRecipient: null };
  return { error: null, confirmRecipient: `The USDC will be sent to this address on ${dst}:\n\n${intent.recipient}\n\nIt is not the account connected here for ${dst}. Sending to an address that is not yours cannot be undone. Continue only if this whole address is yours.` };
}

/**
 * What to tell the user when a step fails, from whatever was thrown. A message the app wrote is shown as it is; a decline in the
 * wallet is said kindly and plainly; anything else keeps a short piece of its own text, so the cause is not hidden behind
 * "something went wrong".
 */
export function explainMoveError(e: unknown): string {
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (e instanceof SwingsError && message) return message;
  if (/reject|declin|denied|cancel|user refused/i.test(message) || (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 4001)) return 'You declined the request in your wallet. Nothing was sent.';
  const detail = message.replace(/\s+/g, ' ').trim().slice(0, 140);
  return `Something went wrong${detail ? `: ${detail}` : ''}. Nothing was assumed: check your wallet's history before you try again.`;
}
