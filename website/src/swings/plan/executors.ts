/**
 * The leg executors that connect a plan to the things that really do the work:
 *  - `SettlementLegExecutor` drives the milestone-34 orchestrator (the wallet signs; the orchestrator keeps the state);
 *  - `BalanceLegExecutor` handles legs the user completes elsewhere (a ramp's hosted page, the swap screen) and finishes
 *    them only when the user's own balance proves it.
 * Nothing here signs or sends by itself.
 */
import type { ChainId } from '../core/types.js';
import type { CrossChainOrchestrator } from '../orchestrator/orchestrator.js';
import type { SettlementQuote } from '../settlement/types.js';
import type { LegExecutor, LegProgress } from './runner.js';
import type { PlanLeg, PlanRecord } from './state.js';

export interface SettlementExecutorOptions {
  orchestrator: Pick<CrossChainOrchestrator, 'create' | 'start' | 'advance' | 'claim' | 'get'>;
  /** The settlement quote behind a leg (by the leg id). Null means it is gone and a new quote is needed. */
  quoteFor: (legId: string) => SettlementQuote | null;
  now?: () => number;
}

export class SettlementLegExecutor implements LegExecutor {
  constructor(private readonly o: SettlementExecutorOptions) {}

  async start(plan: PlanRecord, leg: PlanLeg): Promise<LegProgress> {
    const quoteLeg = plan.quote.legs[leg.index]!;
    const quote = this.o.quoteFor(quoteLeg.id);
    if (!quote || quote.expiresAt <= (this.o.now ?? Date.now)()) return { status: 'needs-requote', instruction: 'The quote for this move expired. Get a new one; nothing was sent.' };
    const rec = await this.o.orchestrator.create(quote);
    const ref = { executionId: rec.id };
    const started = await this.o.orchestrator.start(rec.id);
    return this.map(started.state, started.needsAttention, started.failure, ref, false);
  }

  async poll(_plan: PlanRecord, leg: PlanLeg): Promise<LegProgress> {
    const id = leg.ref.executionId;
    if (!id) return { status: 'failed', reason: 'The record of this move is missing.', fundsMayBeAtRisk: false };
    let rec = await this.o.orchestrator.get(id);
    if (!rec) return { status: 'failed', reason: 'The record of this move is missing.', fundsMayBeAtRisk: true };
    if (rec.state === 'QUOTED' || rec.state === 'AWAITING_SIGNATURE' || rec.state === 'SOURCE_SUBMITTED' || rec.state === 'SOURCE_CONFIRMED') rec = await this.o.orchestrator.start(id);
    let claimable = false;
    if (rec.state === 'SETTLEMENT_PENDING') {
      const a = await this.o.orchestrator.advance(id);
      rec = a.record;
      claimable = a.claimable;
    }
    return this.map(rec.state, rec.needsAttention, rec.failure, { executionId: id }, claimable);
  }

  /** The user pressed "claim": the plan calls this through the screen, then polls. */
  async claim(leg: PlanLeg): Promise<void> {
    if (leg.ref.executionId) await this.o.orchestrator.claim(leg.ref.executionId);
  }

  private map(state: string, attention: string | null, failure: { reason: string; fundsMayBeAtRisk: boolean } | null, ref: { executionId: string }, claimable: boolean): LegProgress {
    if (attention) return { status: 'waiting-user', instruction: attention, ref };
    switch (state) {
      case 'COMPLETED':
        return { status: 'done', ref };
      case 'FAILED':
        return { status: 'failed', reason: failure?.reason ?? 'The move failed.', fundsMayBeAtRisk: failure?.fundsMayBeAtRisk ?? true, ref };
      case 'EXPIRED':
        return { status: 'needs-requote', instruction: 'The quote expired before anything was sent.' };
      case 'QUOTED':
      case 'AWAITING_SIGNATURE':
        return { status: 'waiting-user', instruction: 'Approve the transaction in your wallet.', ref };
      case 'SETTLEMENT_PENDING':
        return claimable ? { status: 'waiting-user', instruction: 'The funds are released. Claim them on the destination network.', ref } : { status: 'active', ref };
      default:
        return { status: 'active', ref };
    }
  }
}

export interface BalanceExecutorOptions {
  /** The user's raw balance of an asset on a chain, or null if it cannot be read (never read as zero). */
  balanceOf: (chain: ChainId, wallet: string, assetKey: string) => Promise<bigint | null>;
  walletFor: (chain: ChainId) => string | null;
  /** What to tell the user to do to begin this leg. */
  instruction: (plan: PlanRecord, leg: PlanLeg) => string;
}

/**
 * For legs the user does elsewhere. It records the balance when the leg begins and finishes the leg only when the
 * balance moved the right way: the OUTPUT asset rose by at least the leg's stated minimum (buy, swap), or the INPUT
 * asset fell (sell, where the payout itself cannot be seen).
 */
export class BalanceLegExecutor implements LegExecutor {
  constructor(private readonly o: BalanceExecutorOptions) {}

  private target(plan: PlanRecord, leg: PlanLeg): { chain: ChainId; assetKey: string; sell: boolean; min: bigint } | null {
    const q = plan.quote.legs[leg.index]!;
    const sell = q.kind === 'ramp-sell';
    const line = sell ? q.input : q.output;
    if (!line.chain) return null;
    return { chain: line.chain, assetKey: line.assetKey, sell, min: !sell && q.kind === 'swap' && line.amount !== null ? line.amount : 1n };
  }

  async start(plan: PlanRecord, leg: PlanLeg): Promise<LegProgress> {
    const t = this.target(plan, leg);
    const wallet = t ? this.o.walletFor(t.chain) : null;
    if (!t || !wallet) return { status: 'waiting-user', instruction: 'Connect the wallet for this step.' };
    const baseline = await this.o.balanceOf(t.chain, wallet, t.assetKey);
    if (baseline === null) return { status: 'waiting-user', instruction: 'Your balance could not be read, so this step cannot begin safely. Try again shortly.' };
    return { status: 'waiting-user', instruction: this.o.instruction(plan, leg), ref: { watchBaseline: baseline.toString() } };
  }

  async poll(plan: PlanRecord, leg: PlanLeg): Promise<LegProgress> {
    const t = this.target(plan, leg);
    const wallet = t ? this.o.walletFor(t.chain) : null;
    const base = leg.ref.watchBaseline;
    if (!t || !wallet || base === undefined) return { status: 'waiting-user', instruction: leg.instruction ?? 'Connect the wallet for this step.' };
    const now = await this.o.balanceOf(t.chain, wallet, t.assetKey);
    if (now === null) return { status: 'waiting-user', instruction: 'Your balance could not be read just now. Nothing is assumed; try again shortly.', ref: undefined };
    const baseline = BigInt(base);
    if (t.sell) return now < baseline ? { status: 'done', ref: { references: ['payout-not-confirmed'] } } : { status: 'waiting-user', instruction: leg.instruction ?? 'Send the crypto to the address the provider showed you.' };
    return now >= baseline + t.min ? { status: 'done' } : { status: 'waiting-user', instruction: leg.instruction ?? 'Waiting for the funds to arrive in your wallet.' };
  }
}
