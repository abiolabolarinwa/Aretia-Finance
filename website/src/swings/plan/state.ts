/**
 * The state of a whole plan (several legs: a ramp, a settlement, a swap...). It sits above the settlement orchestrator's
 * own state machine (milestone 34), which tracks one cross-chain move. A plan's states describe the journey as a whole:
 *
 *   PLANNED > RUNNING <> WAITING_USER > COMPLETED     (or FAILED, CANCELLED, EXPIRED)
 *
 * and each leg has its own status. Rules (tests enforce them):
 *  - nothing leaves a final state;
 *  - a plan is COMPLETED only when every leg is done, in order; no leg is ever skipped to get there;
 *  - once any leg has begun, the plan can no longer be cancelled or expire (money may already be moving): it can only
 *    finish, fail, or wait for the user;
 *  - a failed plan remembers where the user's funds are (the output of the last finished leg), so recovery can say so.
 */
import { SwingsError } from '../core/types.js';
import type { ExecutionQuote, LegKind } from './executionQuote.js';

export const PLAN_STATES = ['PLANNED', 'RUNNING', 'WAITING_USER', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const;
export type PlanState = (typeof PLAN_STATES)[number];
export const PLAN_FINAL: readonly PlanState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED'];

const NEXT: Readonly<Record<PlanState, readonly PlanState[]>> = {
  PLANNED: ['RUNNING', 'CANCELLED', 'EXPIRED', 'FAILED'],
  RUNNING: ['WAITING_USER', 'COMPLETED', 'FAILED'],
  WAITING_USER: ['RUNNING', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};
export const canPlanMove = (from: PlanState, to: PlanState): boolean => NEXT[from].includes(to);
export const isPlanFinal = (s: PlanState): boolean => PLAN_FINAL.includes(s);

export type LegStatus = 'pending' | 'active' | 'waiting-user' | 'needs-requote' | 'done' | 'failed';

export interface LegRef {
  /** The settlement orchestrator's execution id, for a settlement leg. */
  executionId?: string;
  /** Watch data: the balance of the leg's OUTPUT asset when it started (a ramp's or a swap's), so what arrived can be proven. */
  watchBaseline?: string;
  /** For a settlement leg: the destination's USDC balance before the move began, so what landed can be proven. */
  destinationBaseline?: string;
  /** For a swap leg: the least the swap may deliver (raw units) under the quote the user signed. The proof uses it. */
  proofMin?: string;
  /** For a swap leg: how much went in (raw units), under the quote the user signed. */
  spent?: string;
  /** Transaction hashes or order references Aretia knows about, public only. */
  references?: string[];
}

export interface PlanLeg {
  index: number;
  kind: LegKind;
  status: LegStatus;
  ref: LegRef;
  /** What the user must do now, in plain words, when waiting. */
  instruction: string | null;
  startedAt: number | null;
  doneAt: number | null;
}

export interface PlanTransition {
  at: number;
  from: PlanState;
  to: PlanState;
  note: string;
}

export interface PlanRecord {
  id: string;
  version: number;
  state: PlanState;
  quote: ExecutionQuote;
  legs: PlanLeg[];
  createdAt: number;
  updatedAt: number;
  failure: { reason: string; fundsMayBeAtRisk: boolean; legIndex: number | null } | null;
  history: PlanTransition[];
}

/** True once any leg has begun, so the plan can no longer be dropped. */
export const hasBegun = (p: PlanRecord): boolean => p.legs.some((l) => l.status !== 'pending');

export function newPlan(id: string, quote: ExecutionQuote, now: number): PlanRecord {
  return {
    id,
    version: 0,
    state: 'PLANNED',
    quote,
    legs: quote.legs.map((l, index) => ({ index, kind: l.kind, status: 'pending', ref: {}, instruction: null, startedAt: null, doneAt: null })),
    createdAt: now,
    updatedAt: now,
    failure: null,
    history: [],
  };
}

export function movePlan(p: PlanRecord, to: PlanState, note: string, at: number): PlanRecord {
  if (isPlanFinal(p.state)) throw new SwingsError('invalid', `This plan is already ${p.state.toLowerCase()} and cannot change.`);
  if (!canPlanMove(p.state, to)) throw new SwingsError('invalid', `A plan cannot go from ${p.state} to ${to}.`);
  if ((to === 'CANCELLED' || to === 'EXPIRED') && hasBegun(p)) throw new SwingsError('invalid', 'A plan cannot be cancelled or expire after a step has begun.');
  if (to === 'COMPLETED' && !p.legs.every((l) => l.status === 'done')) throw new SwingsError('invalid', 'A plan is complete only when every step is done.');
  return { ...p, state: to, updatedAt: at, history: [...p.history, { at, from: p.state, to, note }] };
}

/** Where the user's money is right now: the output of the last finished leg, or the starting point if none finished. */
export function whereAreTheFunds(p: PlanRecord): { description: string; asset: string; chain: string | null; amount: bigint | null } {
  let last = -1;
  for (const l of p.legs) {
    if (l.status === 'done') last = l.index;
    else break;
  }
  const line = last >= 0 ? p.quote.legs[last]!.output : p.quote.spend;
  const where = line.chain ?? 'your bank or card';
  return { description: last >= 0 ? `${line.symbol} at ${where}, from step ${last + 1}` : `${line.symbol} at ${where}, where you started`, asset: line.symbol, chain: line.chain, amount: line.amount };
}

/**
 * Whether the user may stop the plan here and keep what they hold, with nothing in flight: no leg is active, and no settlement
 * has been started (a started move may already be burning funds, so it must finish or be recovered, never abandoned). A swap the
 * user signed is "active" until its result is known, so it also blocks a stop.
 */
export function canStopHere(p: PlanRecord): boolean {
  if (isPlanFinal(p.state)) return false;
  for (const l of p.legs) {
    if (l.status === 'active' || l.status === 'failed') return false;
    if (l.status !== 'done' && l.kind === 'settlement' && l.ref.executionId) return false;
    if (l.status !== 'done' && l.kind === 'swap') {
      // A swap that was sent and is not known to have failed may still land.
      const refs = l.ref.references ?? [];
      const last = [...refs].reverse().find((r) => r.startsWith('tx:'));
      if (last && !refs.includes(`failed:${last.slice(3)}`)) return false;
    }
  }
  return true;
}
