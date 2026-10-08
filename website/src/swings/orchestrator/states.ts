/**
 * The life of one cross-chain execution, as a state machine whose every move is checked and recorded.
 *
 *   CREATED > QUOTED > AWAITING_SIGNATURE > SOURCE_SUBMITTED > SOURCE_CONFIRMED > SETTLEMENT_PENDING
 *     > DESTINATION_RECEIVED > (DESTINATION_EXECUTED) > COMPLETED
 *   with FAILED, EXPIRED and REFUNDED as the ways it can end otherwise.
 *
 * Rules the transition table and `applyTransition` enforce:
 *  - nothing leaves a final state;
 *  - an execution is COMPLETED only after the destination received the value (never on the source transaction alone);
 *  - a quote may EXPIRE only while no transaction has been submitted. After that, expiry no longer applies, because
 *    the money is already moving and the only honest outcomes are completion, failure or refund.
 */
import { SwingsError } from '../core/types.js';
import type { ChainId } from '../core/types.js';
import type { SettlementQuote } from '../settlement/types.js';

export const EXECUTION_STATES = ['CREATED', 'QUOTED', 'AWAITING_SIGNATURE', 'SOURCE_SUBMITTED', 'SOURCE_CONFIRMED', 'SETTLEMENT_PENDING', 'DESTINATION_RECEIVED', 'DESTINATION_EXECUTED', 'COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED'] as const;
export type ExecutionState = (typeof EXECUTION_STATES)[number];

export const FINAL_STATES: readonly ExecutionState[] = ['COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED'];

const NEXT: Readonly<Record<ExecutionState, readonly ExecutionState[]>> = {
  CREATED: ['QUOTED', 'FAILED', 'EXPIRED'],
  QUOTED: ['AWAITING_SIGNATURE', 'EXPIRED', 'FAILED'],
  // Back to QUOTED when the user declines to sign: nothing was sent, so the quote is simply still waiting.
  AWAITING_SIGNATURE: ['QUOTED', 'SOURCE_SUBMITTED', 'EXPIRED', 'FAILED'],
  SOURCE_SUBMITTED: ['SOURCE_CONFIRMED', 'FAILED'],
  SOURCE_CONFIRMED: ['SETTLEMENT_PENDING', 'FAILED'],
  SETTLEMENT_PENDING: ['DESTINATION_RECEIVED', 'FAILED', 'REFUNDED'],
  DESTINATION_RECEIVED: ['DESTINATION_EXECUTED', 'COMPLETED', 'FAILED'],
  DESTINATION_EXECUTED: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  EXPIRED: [],
  REFUNDED: [],
};

export const isFinal = (s: ExecutionState): boolean => FINAL_STATES.includes(s);
export const canTransition = (from: ExecutionState, to: ExecutionState): boolean => NEXT[from].includes(to);

export type StepStatus = 'pending' | 'sending' | 'submitted' | 'confirmed' | 'failed';

/** One transaction the user signs. `sending` is written BEFORE the wallet is asked, so a crash cannot lead to a second send. */
export interface StepProgress {
  stepId: string;
  chain: ChainId;
  status: StepStatus;
  hash: string | null;
  updatedAt: number;
}

export interface TransitionNote {
  at: number;
  from: ExecutionState;
  to: ExecutionState;
  note: string;
}

export interface ExecutionRecord {
  id: string;
  /** Raised by the store on every write; a write against an old version is refused (two tabs cannot clobber each other). */
  version: number;
  state: ExecutionState;
  quote: SettlementQuote;
  createdAt: number;
  updatedAt: number;
  steps: Record<string, StepProgress>;
  /** The provider's id for following the settlement; set once the burn / send transaction exists. */
  executionId: string | null;
  destinationTxHash: string | null;
  refundTxHash: string | null;
  failure: { reason: string; fundsMayBeAtRisk: boolean } | null;
  /** Set when Aretia cannot tell what happened and will not guess. Cleared by the user's explicit action. */
  needsAttention: string | null;
  history: TransitionNote[];
}

/** True once any transaction has been handed to a wallet, so the quote can no longer simply be dropped. */
export const hasCommitted = (r: ExecutionRecord): boolean => Object.values(r.steps).some((s) => s.status !== 'pending');

/** A copy of the record in a new state, or an error. Pure. */
export function applyTransition(r: ExecutionRecord, to: ExecutionState, note: string, at: number): ExecutionRecord {
  if (isFinal(r.state)) throw new SwingsError('invalid', `This execution is already ${r.state.toLowerCase()} and cannot change.`);
  if (!canTransition(r.state, to)) throw new SwingsError('invalid', `An execution cannot go from ${r.state} to ${to}.`);
  if (to === 'EXPIRED' && hasCommitted(r)) throw new SwingsError('invalid', 'A quote cannot expire after a transaction was sent.');
  return { ...r, state: to, updatedAt: at, history: [...r.history, { at, from: r.state, to, note }] };
}

// ------------------------------------------------------------------ persistence format

const BIGINT_TAG = '$bigint';

/** JSON with bigints preserved. Quotes carry raw token amounts, which are bigints. */
export const serializeRecord = (r: ExecutionRecord): string => JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? { [BIGINT_TAG]: v.toString() } : v));

export function parseRecord(text: string): ExecutionRecord {
  const r = JSON.parse(text, (_k, v) => (v && typeof v === 'object' && typeof (v as Record<string, unknown>)[BIGINT_TAG] === 'string' ? BigInt((v as Record<string, string>)[BIGINT_TAG]!) : v)) as ExecutionRecord;
  if (!r || typeof r.id !== 'string' || !EXECUTION_STATES.includes(r.state) || typeof r.version !== 'number' || !r.quote || typeof r.steps !== 'object' || !Array.isArray(r.history)) {
    throw new SwingsError('invalid', 'A saved execution is damaged and was not loaded.');
  }
  return r;
}
