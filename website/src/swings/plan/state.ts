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
  /** Watch data for a ramp leg: the balance when it started. */
  watchBaseline?: string;
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
