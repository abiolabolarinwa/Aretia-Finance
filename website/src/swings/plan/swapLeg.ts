/**
 * The two executors a cross-chain trade adds to the plan runner. Neither signs or sends by itself.
 *
 *  - `SwapLegExecutor`: a swap inside a plan. When its turn comes it only records the user's balance of what the swap delivers and
 *    waits. The swap is quoted, built, simulated and shown for review only when the user presses the button (`run`), from the amount
 *    that is really there (what the user typed for the first step, what landed from the move for the last one). It is signed in the
 *    user's wallet. The step is done only when the user's own balance shows the swap's output arrived; a failed swap leaves the step
 *    open, so it can be tried again or the plan stopped with the funds where they are.
 *  - `JourneySettlementExecutor`: the deferred USDC move, plus the destination's USDC balance recorded before the move begins, so
 *    the next swap can tell how much landed without guessing.
 *
 * A sent swap is remembered (in the given storage) the moment the wallet returns its transaction id, so a reload never offers to
 * sign the same step twice while the first may still land.
 */
import { CHAINS, SwingsError, type ChainId } from '../core/types.js';
import { formatUnits } from '../crosschain/view.js';
import { landedForSwap, swapProven } from './crossChainTrade.js';
import type { DeferredSettlementExecutor } from './deferred.js';
import type { LegExecutor, LegProgress } from './runner.js';
import type { LegRef, PlanLeg, PlanRecord } from './state.js';

export type TxStatus = 'confirmed' | 'failed' | 'pending' | null;

/** A swap quoted, built and simulated, ready for the user's review. `handle` is opaque to the plan (the router's quote). */
export interface PreparedTrade {
  amountIn: bigint;
  expectedOut: bigint;
  minOut: bigint;
  networkFee: bigint | null;
  simulationOk: boolean;
  blockers: string[];
  warnings: string[];
  handle: unknown;
}

export type SendResult = { status: 'sent'; txId: string } | { status: 'declined' } | { status: 'not-sent'; reason: string } | { status: 'failed'; reason: string; txId?: string };

export interface SwapPorts {
  balanceOf: (chain: ChainId, wallet: string, assetKey: string) => Promise<bigint | null>;
  walletFor: (chain: ChainId) => string | null;
  isNative: (chain: ChainId, assetKey: string) => boolean;
  prepare: (req: { chain: ChainId; from: string; to: string; amountIn: bigint; account: string }) => Promise<PreparedTrade>;
  /** Shows the review. True only if the user confirms. */
  review: (trade: PreparedTrade, plan: PlanRecord, leg: PlanLeg) => Promise<boolean>;
  /** Signs in the user's wallet and sends. */
  send: (trade: PreparedTrade) => Promise<SendResult>;
  txStatus: (chain: ChainId, txId: string) => Promise<TxStatus>;
  /** What the move before this swap said it would deliver, or null if not known. */
  settledAmount: (plan: PlanRecord, moveLeg: PlanLeg) => Promise<bigint | null>;
  /** Remembers a sent swap until the plan records it. */
  memory: { get(key: string): string | null; set(key: string, value: string): void };
}

interface Sent {
  txId: string;
  min: string;
  spent: string;
  networkFee: string | null;
}

const memKey = (plan: PlanRecord, leg: PlanLeg): string => `aretia-journey-swap:${plan.id}:${leg.index}`;
const TX = 'tx:';
const FAILED = 'failed:';

/** The transaction ids recorded on a leg, and which of them are known to have failed. */
function txs(ref: LegRef): { all: string[]; failed: Set<string> } {
  const refs = ref.references ?? [];
  return { all: refs.filter((r) => r.startsWith(TX)).map((r) => r.slice(TX.length)), failed: new Set(refs.filter((r) => r.startsWith(FAILED)).map((r) => r.slice(FAILED.length))) };
}

export class SwapLegExecutor implements LegExecutor {
  /** Legs whose run is in progress in this page (review open, or the wallet is signing). */
  private readonly running = new Set<string>();

  constructor(private readonly o: SwapPorts) {}

  private shape(plan: PlanRecord, leg: PlanLeg) {
    const q = plan.quote.legs[leg.index]!;
    const chain = q.input.chain;
    if (!chain || q.output.chain !== chain) throw new SwingsError('invalid', 'This swap step is missing its network.');
    return { q, chain, inKey: q.input.assetKey, outKey: q.output.assetKey };
  }

  private remembered(plan: PlanRecord, leg: PlanLeg): Sent | null {
    const raw = this.o.memory.get(memKey(plan, leg));
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as Sent;
      return typeof v.txId === 'string' ? v : null;
    } catch {
      return null;
    }
  }

  async start(plan: PlanRecord, leg: PlanLeg): Promise<LegProgress> {
    const { chain, outKey, q } = this.shape(plan, leg);
    const wallet = this.o.walletFor(chain);
    if (!wallet) return { status: 'waiting-user', instruction: `Connect your wallet on ${CHAINS[chain].name} for this step.` };
    const baseline = await this.o.balanceOf(chain, wallet, outKey);
    if (baseline === null) return { status: 'waiting-user', instruction: 'Your balance could not be read, so this step cannot begin safely. Try again shortly.' };
    return { status: 'waiting-user', instruction: `Review and sign the swap of ${q.input.symbol} for ${q.output.symbol} on ${CHAINS[chain].name}.`, ref: { watchBaseline: baseline.toString() } };
  }

  async poll(plan: PlanRecord, leg: PlanLeg): Promise<LegProgress> {
    if (leg.ref.watchBaseline === undefined) return this.start(plan, leg);
    const { chain, outKey, q } = this.shape(plan, leg);
    const wallet = this.o.walletFor(chain);
    if (!wallet) return { status: 'waiting-user', instruction: `Connect your wallet on ${CHAINS[chain].name} for this step.` };

    // A swap the wallet sent but the plan has not recorded yet (the page was busy, or reloaded) is recorded now.
    const mem = this.remembered(plan, leg);
    const known = txs(leg.ref);
    const references = [...(leg.ref.references ?? [])];
    const ref: LegRef = {};
    if (mem && !known.all.includes(mem.txId)) {
      references.push(TX + mem.txId);
      Object.assign(ref, { proofMin: mem.min, spent: mem.spent });
    }
    ref.references = references;
    const all = txs({ references });
    const last = all.all[all.all.length - 1];
    const ready: LegProgress = { status: 'waiting-user', instruction: `Review and sign the swap of ${q.input.symbol} for ${q.output.symbol} on ${CHAINS[chain].name}.`, ref };
    if (!last || all.failed.has(last)) return all.failed.size ? { ...ready, instruction: `The last swap attempt failed on ${CHAINS[chain].name}, so nothing was swapped and your ${q.input.symbol} is still in your wallet. Review it again, or stop here and keep it.` } : ready;

    const min = BigInt(ref.proofMin ?? leg.ref.proofMin ?? mem?.min ?? '0');
    const now = await this.o.balanceOf(chain, wallet, outKey);
    if (swapProven({ baseline: BigInt(leg.ref.watchBaseline), now, min, outputIsNative: this.o.isNative(chain, outKey), networkFee: mem?.networkFee ? BigInt(mem.networkFee) : null })) return { status: 'done', ref };
    const status = await this.o.txStatus(chain, last);
    if (status === 'failed') return { ...ready, instruction: `The swap failed on ${CHAINS[chain].name}, so nothing was swapped and your ${q.input.symbol} is still in your wallet. Review it again, or stop here and keep it.`, ref: { ...ref, references: [...references, FAILED + last] } };
    if (status === 'confirmed') {
      if (now === null) return { status: 'waiting-user', instruction: 'The swap is confirmed, but your balance could not be read to prove it. Nothing is assumed; check again shortly.', ref };
      return { status: 'waiting-user', instruction: `The swap is confirmed on ${CHAINS[chain].name}, but your ${q.output.symbol} balance does not show it yet. Check again in a moment; do not swap again.`, ref };
    }
    // Pending or unknown: the swap may still land. Never offer to sign it again while that is possible.
    return { status: 'active', ref };
  }

  /** True while this leg may be reviewed and signed now: it is the plan's current step and nothing it sent may still land. */
  canRun(plan: PlanRecord, leg: PlanLeg): boolean {
    if (leg.kind !== 'swap' || leg.status !== 'waiting-user' || leg.ref.watchBaseline === undefined) return false;
    if (plan.legs.some((l) => l.index < leg.index && l.status !== 'done')) return false;
    if (this.running.has(memKey(plan, leg))) return false;
    const mem = this.remembered(plan, leg);
    const { all, failed } = txs(leg.ref);
    if (mem && !all.includes(mem.txId)) return false;
    const last = all[all.length - 1];
    return !last || failed.has(last);
  }

  /** How much this swap takes now: what the user typed (first step), or what landed from the move before it (last step). */
  async amountNow(plan: PlanRecord, leg: PlanLeg): Promise<bigint> {
    const { chain, inKey, q } = this.shape(plan, leg);
    const wallet = this.o.walletFor(chain);
    if (!wallet) throw new SwingsError('invalid', `Connect your wallet on ${CHAINS[chain].name} for this step.`);
    const have = await this.o.balanceOf(chain, wallet, inKey);
    if (have === null) throw new SwingsError('provider-failed', 'Your balance could not be read, so the swap was not prepared. Nothing was sent.');
    if (leg.index === 0) {
      const entered = plan.quote.spend.amount;
      if (entered === null || entered <= 0n) throw new SwingsError('invalid', 'This plan does not say how much to swap, so it will not guess.');
      if (have < entered) throw new SwingsError('invalid', `Your wallet holds ${formatUnits(have, q.input.decimals)} ${q.input.symbol}, less than the ${formatUnits(entered, q.input.decimals)} planned. Nothing was sent.`);
      return entered;
    }
    const move = plan.legs[leg.index - 1]!;
    if (move.kind !== 'settlement' || move.status !== 'done') throw new SwingsError('invalid', 'The move before this swap has not finished.');
    const base = move.ref.destinationBaseline;
    if (base === undefined) throw new SwingsError('invalid', 'Aretia cannot tell how much USDC landed from the move, so it will not guess. Your USDC is in your wallet; swap it yourself on the Swap screen.');
    const landed = landedForSwap(BigInt(base), have, await this.o.settledAmount(plan, move));
    if (landed === null) throw new SwingsError('invalid', 'The USDC from the move has not shown in your wallet yet. Check again shortly.');
    return landed;
  }

  /**
   * The user pressed "Review the swap": quote, build and simulate from the amount really there, show the review, and on the user's yes
   * sign it in their wallet. Returns what happened; the caller then steps the plan so the result is recorded.
   */
  async run(plan: PlanRecord, leg: PlanLeg): Promise<'sent' | 'declined' | 'not-sent'> {
    if (!this.canRun(plan, leg)) throw new SwingsError('invalid', 'This swap cannot be signed now. If one was sent, wait for its result; do not sign again.');
    const key = memKey(plan, leg);
    this.running.add(key);
    try {
      const { chain, inKey, outKey } = this.shape(plan, leg);
      const wallet = this.o.walletFor(chain)!;
      const amountIn = await this.amountNow(plan, leg);
      const trade = await this.o.prepare({ chain, from: inKey, to: outKey, amountIn, account: wallet });
      if (trade.amountIn !== amountIn) throw new SwingsError('invalid', 'The prepared swap does not spend the planned amount, so it was not shown. Nothing was sent.');
      if (!trade.simulationOk) throw new SwingsError('simulation-failed', `${trade.blockers.join(' ') || 'The swap failed its checks.'} Nothing was sent.`);
      if (!(await this.o.review(trade, plan, leg))) return 'declined';
      const sent = await this.o.send(trade);
      if (sent.status === 'declined') return 'declined';
      if (sent.status === 'not-sent') return 'not-sent';
      if (sent.status === 'failed' && !sent.txId) throw new SwingsError('invalid', `${sent.reason} Nothing was swapped.`);
      const txId = sent.status === 'sent' ? sent.txId : sent.txId!;
      this.o.memory.set(key, JSON.stringify({ txId, min: trade.minOut.toString(), spent: amountIn.toString(), networkFee: trade.networkFee === null ? null : trade.networkFee.toString() } satisfies Sent));
      return 'sent';
    } finally {
      this.running.delete(key);
    }
  }
}

/**
 * The deferred USDC move, with the destination's USDC balance recorded before it begins. The move starts only after the user pressed
 * its button on this page (`arm`), never from a background check: starting it asks the wallet to sign.
 */
export class JourneySettlementExecutor implements LegExecutor {
  private readonly armed = new Set<string>();

  /** The user asked for this move to start now. */
  arm(plan: PlanRecord, leg: PlanLeg): void {
    this.armed.add(`${plan.id}:${leg.index}`);
  }

  constructor(
    private readonly deferred: Pick<DeferredSettlementExecutor, 'start' | 'poll' | 'claim'>,
    private readonly o: { balanceOf: SwapPorts['balanceOf']; walletFor: SwapPorts['walletFor']; usdc: (c: ChainId) => string | null },
  ) {}

  async start(plan: PlanRecord, leg: PlanLeg): Promise<LegProgress> {
    let base = leg.ref.destinationBaseline;
    if (base === undefined) {
      const dst = plan.quote.legs[leg.index]!.output.chain;
      const wallet = dst ? this.o.walletFor(dst) : null;
      const usdc = dst ? this.o.usdc(dst) : null;
      if (!dst || !wallet || !usdc) return { status: 'waiting-user', instruction: `Connect your wallet on ${dst ? CHAINS[dst].name : 'the destination network'} to receive the USDC there. Nothing was sent.` };
      const b = await this.o.balanceOf(dst, wallet, usdc);
      if (b === null) return { status: 'waiting-user', instruction: 'Your USDC balance on the destination could not be read, so the move was not started. Try again shortly.' };
      base = b.toString();
    }
    if (!this.armed.has(`${plan.id}:${leg.index}`)) {
      const q = plan.quote.legs[leg.index]!;
      return { status: 'waiting-user', instruction: `Start the USDC move from ${CHAINS[q.input.chain!].name} to ${CHAINS[q.output.chain!].name}. It is priced from the USDC really in your wallet, checked, and then your wallet asks you to sign.`, ref: { destinationBaseline: base } };
    }
    const p = await this.deferred.start(plan, leg);
    if (p.status === 'needs-requote') return p;
    return { ...p, ref: { ...(p.ref ?? {}), destinationBaseline: base } } as LegProgress;
  }

  async poll(plan: PlanRecord, leg: PlanLeg): Promise<LegProgress> {
    return leg.ref.executionId ? this.deferred.poll(plan, leg) : this.start(plan, leg);
  }

  claim(leg: PlanLeg): Promise<void> {
    return this.deferred.claim(leg);
  }
}
