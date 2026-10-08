/**
 * What the cross-chain screen says, as plain data. Kept apart from the page so every word the user is shown about money
 * can be tested: amounts are exact (no floating point), fees are shown one by one and never merged into a vague total,
 * and a status never says "done" before the destination has the funds.
 */
import { CHAINS } from '../core/types.js';
import type { ExecutionRecord } from '../orchestrator/states.js';
import type { SettlementQuote } from '../settlement/types.js';

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
    { label: 'Settlement fee', value: q.settlementFee.amount === 0n ? 'None' : `${formatUnits(q.settlementFee.amount, decimals)} ${symbol}` },
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
      return { title: `Sent on ${src}`, detail: 'Waiting for the network to confirm. The funds have not arrived yet.', tone: 'progress', next: 'wait' };
    case 'SOURCE_CONFIRMED':
    case 'SETTLEMENT_PENDING':
      return claimable
        ? { title: `Ready to claim on ${dst}`, detail: `The funds are released. Claim them with your wallet on ${dst}; you need a little ${CHAINS[r.quote.intent.destinationChain].nativeSymbol} for the fee. Until you claim, they are not in your ${dst} account.`, tone: 'warn', next: 'claim' }
        : { title: `Moving to ${dst}`, detail: r.steps['mint'] ? 'Your claim was sent. Waiting for it to confirm.' : 'Sent and confirmed on the first network. Waiting for the settlement. The funds have not arrived yet.', tone: 'progress', next: 'wait' };
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
