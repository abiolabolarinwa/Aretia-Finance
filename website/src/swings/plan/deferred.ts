/**
 * A settlement step that cannot be priced when the plan is made, because how much USDC will arrive from the step before
 * (a purchase) is not known until it arrives. So this step is quoted when its turn comes, from the amount that actually
 * landed in the user's wallet, and it still goes through every check an ordinary move goes through (the quote engine,
 * the safety engine, the user's acknowledgement of anything flagged).
 *
 * If anything stops it (no route, a blocker, a risk the user has not accepted) the plan WAITS with the reason. The funds
 * are safe in the user's own wallet in the meantime; nothing is sent.
 */
import type { ChainId } from '../core/types.js';
import { CHAINS } from '../core/types.js';
import type { SafetyVerdict } from '../settlement/safety.js';
import type { SettlementQuoteEngine } from '../settlement/engine.js';
import type { SettlementQuote } from '../settlement/types.js';
import type { LegExecutor, LegProgress } from './runner.js';
import type { PlanLeg, PlanRecord } from './state.js';
import type { SettlementLegExecutor } from './executors.js';
import { formatUnits } from '../crosschain/view.js';

export interface DeferredOptions {
  inner: SettlementLegExecutor;
  /** The quote map the inner executor reads (leg id to quote). */
  quotes: Map<string, SettlementQuote>;
  engine: Pick<SettlementQuoteEngine, 'quote'>;
  balanceOf: (chain: ChainId, wallet: string, assetKey: string) => Promise<bigint | null>;
  walletFor: (chain: ChainId) => string | null;
  usdc: (chain: ChainId) => string | null;
  assess: (quote: SettlementQuote) => Promise<SafetyVerdict>;
  /** Shows the flagged risks to the user. True only if they explicitly accept. */
  acknowledge: (confirmations: string[]) => Promise<boolean>;
}

export class DeferredSettlementExecutor implements LegExecutor {
  constructor(private readonly o: DeferredOptions) {}

  async start(plan: PlanRecord, leg: PlanLeg): Promise<LegProgress> {
    const shape = plan.quote.legs[leg.index]!;
    const src = shape.input.chain;
    const dst = shape.output.chain;
    if (!src || !dst) return { status: 'waiting-user', instruction: 'This step is missing a network.' };
    const wallet = this.o.walletFor(src);
    const asset = this.o.usdc(src);
    const destAsset = this.o.usdc(dst);
    if (!wallet || !asset || !destAsset) return { status: 'waiting-user', instruction: `Connect your wallet on ${CHAINS[src].name} to continue.` };
    const before = plan.legs[leg.index - 1]?.ref.watchBaseline;
    if (before === undefined) return { status: 'waiting-user', instruction: 'Aretia cannot tell how much arrived from the step before, so it will not guess. Move the USDC yourself in the Move USDC tab.' };
    const now = await this.o.balanceOf(src, wallet, asset);
    if (now === null) return { status: 'waiting-user', instruction: 'Your balance could not be read just now. Nothing is assumed; try again shortly.' };
    const arrived = now - BigInt(before);
    if (arrived <= 0n) return { status: 'waiting-user', instruction: 'The USDC has not arrived yet.' };

    const search = await this.o.engine.quote({ sourceChain: src, sourceAsset: { chain: src, address: asset }, sourceAmount: arrived, destinationChain: dst, destinationAsset: { chain: dst, address: destAsset }, sender: wallet, recipient: wallet }, 'balanced');
    const best = search.quotes[0];
    if (!best) {
      const why = [...search.declined.map((d) => d.reason), ...search.failures.map((f) => f.message)].join(' ');
      return { status: 'waiting-user', instruction: `${formatUnits(arrived, 6)} USDC arrived on ${CHAINS[src].name}, but no route to ${CHAINS[dst].name} is available right now. Your USDC is safe in your wallet. ${why}`.trim() };
    }
    const verdict = await this.o.assess(best);
    if (verdict.verdict === 'block') return { status: 'waiting-user', instruction: `The move was not started: ${verdict.blockers.join(' ')} Your USDC is safe in your wallet.` };
    if (verdict.verdict === 'confirm' && !(await this.o.acknowledge(verdict.confirmations))) return { status: 'waiting-user', instruction: 'Waiting for you to accept the risks listed before the move starts. Your USDC is safe in your wallet.' };

    this.o.quotes.set(shape.id, best);
    return this.o.inner.start(plan, leg);
  }

  async poll(plan: PlanRecord, leg: PlanLeg): Promise<LegProgress> {
    // Until a move exists there is nothing to follow: try to start it (again).
    return leg.ref.executionId ? this.o.inner.poll(plan, leg) : this.start(plan, leg);
  }

  claim(leg: PlanLeg): Promise<void> {
    return this.o.inner.claim(leg);
  }
}
