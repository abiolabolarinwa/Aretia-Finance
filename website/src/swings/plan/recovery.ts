/**
 * Recovery: for every plan or move that is not finished, say plainly what state it is in, where the user's money is,
 * what is safe to do, and what must NOT be done. Pure and deterministic: the same records always give the same advice.
 *
 * Principles:
 *  - say where the funds are before anything else; if that cannot be known, say so;
 *  - never suggest sending again when a previous send might have gone through;
 *  - never call something lost: "may be in transit" and "check" are the honest words until a chain says otherwise;
 *  - recovery never moves funds by itself: every action here is something the user chooses.
 */
import { CHAINS } from '../core/types.js';
import type { ExecutionRecord } from '../orchestrator/states.js';
import { isFinal } from '../orchestrator/states.js';
import { isPlanFinal, whereAreTheFunds, type PlanRecord } from './state.js';

export type Severity = 'info' | 'attention' | 'urgent';
export type ActionId = 'check-wallet' | 'claim' | 'requote' | 'retry-step' | 'check-provider' | 'keep-funds' | 'resume' | 'wait';

export interface RecoveryAction {
  id: ActionId;
  label: string;
  explanation: string;
}

export interface RecoveryItem {
  subject: { kind: 'plan' | 'execution'; id: string };
  severity: Severity;
  problem: string;
  fundsAt: string;
  actions: RecoveryAction[];
  neverDo: string[];
}

const MIN = 60_000;
const NEVER_RESEND = 'Do not send the transaction again until you have checked your wallet history: the first one may have gone through.';

/** Advice for one cross-chain move. `claimable` is what the provider last said. */
export function diagnoseExecution(r: ExecutionRecord, now: number, claimable = false): RecoveryItem[] {
  const subject = { kind: 'execution' as const, id: r.id };
  const items: RecoveryItem[] = [];
  const idle = now - r.updatedAt;
  const src = CHAINS[r.quote.intent.sourceChain].name;
  const dst = CHAINS[r.quote.intent.destinationChain].name;
  if (r.needsAttention) {
    items.push({ subject, severity: 'urgent', problem: r.needsAttention, fundsAt: 'Unknown until you check your wallet history.', actions: [{ id: 'check-wallet', label: 'Check your wallet history', explanation: 'Look for the transaction in your wallet or on a block explorer, then tell Aretia whether it was sent.' }], neverDo: [NEVER_RESEND] });
  }
  if (isFinal(r.state)) {
    if (r.state === 'FAILED' && r.failure?.fundsMayBeAtRisk) {
      items.push({ subject, severity: 'urgent', problem: `The move did not complete after the funds left ${src}: ${r.failure.reason}`, fundsAt: `Possibly in transit between ${src} and ${dst}. Nothing has reported them gone.`, actions: [{ id: 'check-provider', label: 'Check the settlement provider', explanation: 'Use the transaction hash from the first network to look the transfer up. Keep every hash.' }], neverDo: ['Do not start the same move again until you know where the first one stands.'] });
    } else if (r.state === 'FAILED') {
      items.push({ subject, severity: 'info', problem: r.failure?.reason ?? 'The move failed before any funds moved.', fundsAt: `Still in your account on ${src}.`, actions: [{ id: 'requote', label: 'Start again with a new quote', explanation: 'Nothing was moved by the failed step.' }], neverDo: [] });
    }
    return items;
  }
  if (r.state === 'SETTLEMENT_PENDING' && claimable && idle > 30 * MIN) {
    items.push({ subject, severity: 'attention', problem: `The funds are released and waiting for you to claim them on ${dst}.`, fundsAt: `Released by the settlement, not yet in your ${dst} account.`, actions: [{ id: 'claim', label: `Claim on ${dst}`, explanation: `Needs a little gas on ${dst}.` }], neverDo: [] });
  } else if (r.state === 'SETTLEMENT_PENDING' && idle > 2 * 60 * MIN) {
    items.push({ subject, severity: 'attention', problem: 'The settlement has taken much longer than expected.', fundsAt: `Burned or locked on ${src}; not yet released on ${dst}.`, actions: [{ id: 'check-provider', label: 'Check the settlement provider', explanation: 'Look the transfer up with its first-network transaction hash.' }, { id: 'wait', label: 'Keep waiting', explanation: 'Some routes are slow when the source network is congested.' }], neverDo: ['Do not start the same move again.'] });
  } else if (r.state === 'SOURCE_SUBMITTED' && idle > 15 * MIN) {
    items.push({ subject, severity: 'attention', problem: `The transaction on ${src} has not confirmed for a long time.`, fundsAt: `Not yet confirmed on ${src}; still in your account unless it confirms.`, actions: [{ id: 'check-wallet', label: 'Check the transaction', explanation: 'It may be stuck for a low fee, or confirmed and not yet noticed.' }, { id: 'resume', label: 'Check again', explanation: 'Aretia will ask the network once more.' }], neverDo: [NEVER_RESEND] });
  } else if (r.state === 'QUOTED' || r.state === 'AWAITING_SIGNATURE') {
    if (r.quote.expiresAt <= now) items.push({ subject, severity: 'info', problem: 'The quote has expired. Nothing was sent.', fundsAt: `In your account on ${src}.`, actions: [{ id: 'requote', label: 'Get a new quote', explanation: 'Prices and fees may have changed.' }], neverDo: [] });
  }
  return items;
}

/** Advice for a whole plan. `executions` are the settlement moves the plan refers to, by execution id. */
export function diagnosePlan(p: PlanRecord, now: number, executions: ReadonlyMap<string, ExecutionRecord> = new Map()): RecoveryItem[] {
  const subject = { kind: 'plan' as const, id: p.id };
  const items: RecoveryItem[] = [];
  const funds = whereAreTheFunds(p);

  // The plan and the move it refers to must agree.
  for (const l of p.legs) {
    const ex = l.ref.executionId ? executions.get(l.ref.executionId) : undefined;
    if (l.status === 'done' && ex && ex.state !== 'COMPLETED') {
      items.push({ subject, severity: 'urgent', problem: `The plan says step ${l.index + 1} is done, but the move behind it is ${ex.state.toLowerCase()}.`, fundsAt: funds.description, actions: [{ id: 'check-wallet', label: 'Check your balances', explanation: 'The records disagree, so check where the funds are on each network before anything else.' }], neverDo: ['Do not continue the plan until the records agree.'] });
    }
  }

  if (p.state === 'FAILED') {
    const leg = p.failure?.legIndex !== null && p.failure?.legIndex !== undefined ? p.legs[p.failure.legIndex] : undefined;
    const risk = p.failure?.fundsMayBeAtRisk === true;
    items.push({
      subject,
      severity: risk ? 'urgent' : 'attention',
      problem: `The plan stopped${leg ? ` at step ${leg.index + 1} (${leg.kind})` : ''}: ${p.failure?.reason ?? 'it failed'}`,
      fundsAt: risk ? `Possibly in transit. Last known: ${funds.description}.` : `${funds.description}. The later steps did not run.`,
      actions: risk
        ? [{ id: 'check-provider', label: 'Check the provider', explanation: 'Look up the failed step with its transaction hash or order reference. Keep every reference.' }]
        : [{ id: 'keep-funds', label: `Keep the ${funds.asset}`, explanation: 'You can leave it where it is.' }, { id: 'retry-step', label: 'Plan the remaining steps again', explanation: 'A new quote is made from where your funds are now.' }],
      neverDo: risk ? ['Do not start the plan again from the beginning.'] : [],
    });
    return items;
  }
  if (isPlanFinal(p.state)) return items;

  const waiting = p.legs.find((l) => l.status === 'needs-requote');
  if (waiting) {
    items.push({ subject, severity: 'info', problem: `A quote for step ${waiting.index + 1} expired before it could be used.`, fundsAt: `${funds.description}. Nothing is lost by waiting.`, actions: [{ id: 'requote', label: 'Get a new quote for the remaining steps', explanation: 'Prices and fees may have changed.' }], neverDo: [] });
  }
  const ramp = p.legs.find((l) => (l.kind === 'ramp-buy' || l.kind === 'ramp-sell') && (l.status === 'active' || l.status === 'waiting-user'));
  if (ramp && ramp.startedAt !== null && now - ramp.startedAt > 24 * 60 * MIN) {
    items.push({ subject, severity: 'attention', problem: `The ${ramp.kind === 'ramp-buy' ? 'purchase' : 'sale'} has been open for over a day.`, fundsAt: ramp.kind === 'ramp-buy' ? 'Your payment may have been taken; the crypto has not arrived in your wallet.' : 'Your crypto has not left your wallet, or the payout has not arrived.', actions: [{ id: 'check-provider', label: 'Contact the provider', explanation: 'They hold the order. Give them the reference from your confirmation email.' }], neverDo: ['Do not pay again for the same order.'] });
  }
  if (p.state === 'WAITING_USER' && !waiting) {
    const leg = p.legs.find((l) => l.status === 'waiting-user');
    if (leg?.instruction) items.push({ subject, severity: 'info', problem: `Waiting for you: ${leg.instruction}`, fundsAt: funds.description, actions: [{ id: 'resume', label: 'Continue', explanation: 'Aretia checks the step again.' }], neverDo: [] });
  }
  if (items.length === 0 && now - p.updatedAt > 7 * 24 * 60 * MIN) {
    items.push({ subject, severity: 'info', problem: 'This plan has not moved for over a week.', fundsAt: funds.description, actions: [{ id: 'resume', label: 'Check it again', explanation: 'Nothing changes unless you continue.' }], neverDo: [] });
  }
  return items;
}

/** Everything that needs a look, most urgent first. */
export function triage(items: readonly RecoveryItem[]): RecoveryItem[] {
  const order: Record<Severity, number> = { urgent: 0, attention: 1, info: 2 };
  return [...items].sort((a, b) => order[a.severity] - order[b.severity] || (a.subject.id < b.subject.id ? -1 : 1));
}
