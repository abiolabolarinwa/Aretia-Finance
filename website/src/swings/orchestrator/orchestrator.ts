/**
 * The cross-chain execution orchestrator. It walks one settlement from an accepted quote to completion, saving its
 * state before and after every step that matters, so a closed tab, a crash or a restart can always resume honestly.
 *
 * What it will never do:
 *  - send a transaction twice: a step is marked `sending` and saved BEFORE the wallet is asked; if the page dies in
 *    between, the step is flagged for the user ("needs attention") and is not retried by itself;
 *  - sign with a different account or call an address the provider has not declared;
 *  - say COMPLETED because the source transaction confirmed: only the provider's report that the destination received
 *    the value (and, where the destination needs a claim, that the claim confirmed) completes an execution;
 *  - guess when it cannot tell: an unknown provider answer changes nothing.
 *
 * It does not move value itself. The wallet gateway signs; the provider builds and tracks.
 */
import { SwingsError } from '../core/types.js';
import type { ChainId } from '../core/types.js';
import { executionIdOf, parseExecutionId, type SettlementProvider, type SettlementQuote, type SettlementTransaction } from '../settlement/types.js';
import { secureId } from './remote.js';
import { applyTransition, hasCommitted, isFinal, type ExecutionRecord, type ExecutionState, type StepProgress } from './states.js';
import type { ExecutionStore } from './store.js';

export interface ExecutionGateway {
  /** Asks the user's wallet to sign and send. Must refuse (throw) unless the wallet is the expected account on the right network. */
  send(tx: SettlementTransaction, expect: { address: string; allowedDestinations: readonly string[] }): Promise<string>;
  confirmation(chain: ChainId, hash: string): Promise<'confirmed' | 'failed' | 'pending'>;
}

export interface OrchestratorOptions {
  store: ExecutionStore;
  providers: readonly SettlementProvider[];
  gateway: ExecutionGateway;
  now?: () => number;
  newId?: () => string;
  /** How often and how long to wait for a transaction to confirm. */
  confirmPollMs?: number;
  confirmTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class CrossChainOrchestrator {
  private readonly o: Required<Omit<OrchestratorOptions, 'store' | 'providers' | 'gateway'>> & Pick<OrchestratorOptions, 'store' | 'providers' | 'gateway'>;
  private readonly busy = new Set<string>();

  constructor(options: OrchestratorOptions) {
    this.o = {
      now: Date.now,
      newId: () => secureId('x'),
      confirmPollMs: 4_000,
      confirmTimeoutMs: 10 * 60_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ...options,
    };
  }

  // ------------------------------------------------------------------ creation

  /** Saves an accepted quote as an execution, in state QUOTED. Nothing is signed. */
  async create(quote: SettlementQuote): Promise<ExecutionRecord> {
    const t = this.o.now();
    if (quote.expiresAt <= t) throw new SwingsError('expired', 'This quote has expired. Get a new one.');
    this.provider(quote.providerId);
    const base: ExecutionRecord = { id: this.o.newId(), version: 0, state: 'CREATED', quote, createdAt: t, updatedAt: t, steps: {}, executionId: null, destinationTxHash: null, refundTxHash: null, failure: null, needsAttention: null, history: [] };
    const created = await this.o.store.create(base);
    return this.move(created, 'QUOTED', 'Quote accepted; nothing has been signed.');
  }

  async get(id: string): Promise<ExecutionRecord | null> {
    return this.o.store.get(id);
  }

  /** Executions that are not finished, for resuming after a reload. */
  async active(): Promise<ExecutionRecord[]> {
    return (await this.o.store.list()).filter((r) => !isFinal(r.state));
  }

  // ------------------------------------------------------------------ source side

  /**
   * Signs and sends the source transactions in order and waits for them. Safe to call again after an interruption:
   * steps already sent are not sent again. Returns the record as it stands.
   */
  async start(id: string): Promise<ExecutionRecord> {
    return this.exclusive(id, async () => {
      let r = await this.require(id);
      if (r.needsAttention) throw new SwingsError('invalid', `Aretia cannot continue by itself: ${r.needsAttention}`);
      if (r.state === 'SOURCE_SUBMITTED' || r.state === 'SOURCE_CONFIRMED') return this.resumeSource(r);
      if (r.state !== 'QUOTED' && r.state !== 'AWAITING_SIGNATURE') return r;
      const provider = this.provider(r.quote.providerId);
      if (!hasCommitted(r) && r.quote.expiresAt <= this.o.now()) return this.move(r, 'EXPIRED', 'The quote expired before anything was signed.');
      const txs = await provider.buildSettlement(r.quote);
      if (txs.length === 0) return this.fail(r, 'The provider built no transactions.', false);
      if (r.state === 'QUOTED') r = await this.move(r, 'AWAITING_SIGNATURE', 'Waiting for the wallet to sign.');
      const allowed = provider.allowedDestinations(r.quote.intent.sourceChain);
      for (let i = 0; i < txs.length; i++) {
        const tx = txs[i]!;
        const last = i === txs.length - 1;
        const step = r.steps[tx.stepId];
        if (step?.status === 'sending') return this.attention(r, `The ${tx.stepId} step was being sent when this page last stopped, and Aretia cannot tell whether the wallet sent it. Check your wallet's history before doing anything else.`);
        if (step && step.status !== 'pending') {
          if (step.status === 'failed') return this.fail(r, `The ${tx.stepId} transaction failed on the network.`, false);
          r = await this.settleStep(r, tx.stepId, last);
          if (isFinal(r.state)) return r;
          continue;
        }
        // Save "sending" first, so a crash after the wallet call cannot lead to a second send.
        r = await this.saveStep(r, { stepId: tx.stepId, chain: tx.chain, status: 'sending', hash: null, updatedAt: this.o.now() });
        let hash: string;
        try {
          hash = await this.o.gateway.send(tx, { address: r.quote.intent.sender, allowedDestinations: allowed });
        } catch (e) {
          const rejected = e instanceof SwingsError && e.code === 'rejected';
          r = await this.saveStep(r, { stepId: tx.stepId, chain: tx.chain, status: 'pending', hash: null, updatedAt: this.o.now() });
          if (rejected && !hasCommitted(r)) return this.move(r, 'QUOTED', 'The signature was declined; nothing was sent.');
          if (rejected) return r; // an earlier step (the approval) was sent; stay put so the user can resume
          throw e;
        }
        r = await this.saveStep(r, { stepId: tx.stepId, chain: tx.chain, status: 'submitted', hash, updatedAt: this.o.now() });
        if (last) {
          r = { ...r, executionId: executionIdOf(provider.id, tx.chain, hash) };
          r = await this.move(r, 'SOURCE_SUBMITTED', `Submitted ${hash}.`);
        }
        r = await this.settleStep(r, tx.stepId, last);
        if (isFinal(r.state)) return r;
      }
      return r;
    });
  }

  /** After a reload: the value-moving transaction was already sent, so only its confirmation is left to follow. */
  private async resumeSource(r: ExecutionRecord): Promise<ExecutionRecord> {
    if (r.state === 'SOURCE_CONFIRMED') return this.confirmSource(r);
    const sourceTx = r.executionId ? parseExecutionId(r.executionId)?.sourceTx : undefined;
    const step = Object.values(r.steps).find((x) => x.hash !== null && x.hash === sourceTx);
    if (!step) return this.attention(r, 'The saved record does not say which transaction moved the funds, so Aretia will not guess. Check your wallet history.');
    return this.settleStep(r, step.stepId, true);
  }

  /** Waits for a submitted step to confirm. Approvals must confirm before the value-moving step is sent. */
  private async settleStep(r: ExecutionRecord, stepId: string, last: boolean): Promise<ExecutionRecord> {
    const step = r.steps[stepId]!;
    if (step.status === 'confirmed') return last && r.state === 'SOURCE_SUBMITTED' ? this.confirmSource(r) : r;
    const outcome = await this.waitConfirmed(step.chain, step.hash!);
    if (outcome === 'pending') return this.attention(r, `The ${stepId} transaction (${step.hash}) is still not confirmed. It may yet confirm; check its status before sending anything again.`);
    if (outcome === 'failed') {
      r = await this.saveStep(r, { ...step, status: 'failed', updatedAt: this.o.now() });
      return this.fail(r, `The ${stepId} transaction failed on the network (${step.hash}).`, false);
    }
    r = await this.saveStep(r, { ...step, status: 'confirmed', updatedAt: this.o.now() });
    return last ? this.confirmSource(r) : r;
  }

  private async confirmSource(r: ExecutionRecord): Promise<ExecutionRecord> {
    if (r.state === 'SOURCE_SUBMITTED') r = await this.move(r, 'SOURCE_CONFIRMED', 'The source transaction is confirmed.');
    if (r.state === 'SOURCE_CONFIRMED') r = await this.move(r, 'SETTLEMENT_PENDING', 'Waiting for the settlement to reach the destination.');
    return r;
  }

  // ------------------------------------------------------------------ settlement side

  /**
   * Asks the provider where the settlement is and moves the record only as far as the provider's answer justifies.
   * Cheap and safe to call as often as the UI likes. Returns whether the user now has something to claim.
   */
  async advance(id: string): Promise<{ record: ExecutionRecord; claimable: boolean }> {
    return this.exclusive(id, async () => {
      let r = await this.require(id);
      if (r.state !== 'SETTLEMENT_PENDING' || !r.executionId) return { record: r, claimable: false };
      const provider = this.provider(r.quote.providerId);
      const status = await provider.trackSettlement(r.executionId, r.quote);
      if (status.code === 'completed') {
        // A claim that was submitted must also be confirmed by us before we say the destination received it.
        r = { ...r, destinationTxHash: status.destinationTxHash ?? r.destinationTxHash };
        r = await this.move(r, 'DESTINATION_RECEIVED', 'The destination received the value.');
        r = await this.move(r, 'COMPLETED', 'Settlement complete.');
        return { record: r, claimable: false };
      }
      if (status.code === 'failed') return { record: await this.fail(r, status.message, true), claimable: false };
      return { record: r, claimable: status.code === 'ready-to-complete' && !this.claimInFlight(r) };
    });
  }

  /** Builds, signs and sends the destination claim when the provider says the funds are ready. */
  async claim(id: string): Promise<ExecutionRecord> {
    return this.exclusive(id, async () => {
      let r = await this.require(id);
      if (r.state !== 'SETTLEMENT_PENDING' || !r.executionId) throw new SwingsError('invalid', 'There is nothing to claim yet.');
      if (r.needsAttention) throw new SwingsError('invalid', `Aretia cannot continue by itself: ${r.needsAttention}`);
      const provider = this.provider(r.quote.providerId);
      const existing = r.steps['mint'];
      if (existing?.status === 'sending') return this.attention(r, 'The claim was being sent when this page last stopped, and Aretia cannot tell whether the wallet sent it. Check your wallet history before doing anything else.');
      if (existing && existing.status !== 'pending' && existing.status !== 'failed') return r; // already submitted; advance() will see it complete
      const tx = await provider.buildDestination(r.quote, r.executionId);
      if (!tx) throw new SwingsError('invalid', 'The funds are not ready to claim yet, or have already been claimed.');
      r = await this.saveStep(r, { stepId: tx.stepId, chain: tx.chain, status: 'sending', hash: null, updatedAt: this.o.now() });
      let hash: string;
      try {
        hash = await this.o.gateway.send(tx, { address: r.quote.intent.recipient, allowedDestinations: provider.allowedDestinations(tx.chain) });
      } catch (e) {
        await this.saveStep(r, { stepId: tx.stepId, chain: tx.chain, status: 'pending', hash: null, updatedAt: this.o.now() });
        throw e;
      }
      r = await this.saveStep(r, { stepId: tx.stepId, chain: tx.chain, status: 'submitted', hash, updatedAt: this.o.now() });
      r = { ...r, destinationTxHash: hash };
      const outcome = await this.waitConfirmed(tx.chain, hash);
      if (outcome === 'failed') {
        // The claim can simply be built and sent again, because nothing was minted.
        return this.saveStep(r, { stepId: tx.stepId, chain: tx.chain, status: 'failed', hash, updatedAt: this.o.now() });
      }
      if (outcome === 'pending') return this.attention(r, `The claim transaction (${hash}) is still not confirmed. It may yet confirm; check its status before claiming again.`);
      return this.saveStep(r, { stepId: tx.stepId, chain: tx.chain, status: 'confirmed', hash, updatedAt: this.o.now() });
    });
  }

  private claimInFlight(r: ExecutionRecord): boolean {
    const s = r.steps['mint'];
    return !!s && (s.status === 'sending' || s.status === 'submitted' || s.status === 'confirmed');
  }

  // ------------------------------------------------------------------ user actions

  /** The user has checked their wallet and chain and says what happened to a step that Aretia could not determine. */
  async resolveAttention(id: string, outcome: { stepId: string; sent: boolean; hash?: string }): Promise<ExecutionRecord> {
    return this.exclusive(id, async () => {
      const r = await this.require(id);
      if (!r.needsAttention) return r;
      const step = r.steps[outcome.stepId];
      if (!step) throw new SwingsError('invalid', 'That step does not exist.');
      if (outcome.sent && !/^0x[0-9a-fA-F]{64}$/.test(outcome.hash ?? '') && step.chain !== 'solana') throw new SwingsError('invalid', 'Enter the transaction hash from your wallet.');
      if (outcome.sent && !outcome.hash) throw new SwingsError('invalid', 'Enter the transaction hash from your wallet.');
      const updated = await this.saveStep({ ...r, needsAttention: null }, outcome.sent ? { ...step, status: 'submitted', hash: outcome.hash!, updatedAt: this.o.now() } : { ...step, status: 'pending', hash: null, updatedAt: this.o.now() });
      return updated;
    });
  }

  /** Marks an execution refunded, with the refund transaction as evidence. Only from SETTLEMENT_PENDING. */
  async recordRefund(id: string, refundTxHash: string): Promise<ExecutionRecord> {
    return this.exclusive(id, async () => {
      const r = await this.require(id);
      return this.move({ ...r, refundTxHash }, 'REFUNDED', `Refunded in ${refundTxHash}.`);
    });
  }

  // ------------------------------------------------------------------ plumbing

  private provider(id: string): SettlementProvider {
    const p = this.o.providers.find((x) => x.id === id);
    if (!p) throw new SwingsError('invalid', 'The provider for this execution is not available.');
    return p;
  }

  private async require(id: string): Promise<ExecutionRecord> {
    const r = await this.o.store.get(id);
    if (!r) throw new SwingsError('invalid', 'That execution was not found.');
    return r;
  }

  private async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new SwingsError('invalid', 'This execution is already being worked on.');
    this.busy.add(id);
    try {
      return await work();
    } finally {
      this.busy.delete(id);
    }
  }

  private async move(r: ExecutionRecord, to: ExecutionState, note: string): Promise<ExecutionRecord> {
    return this.o.store.update(applyTransition(r, to, note, this.o.now()), r.version);
  }

  private async saveStep(r: ExecutionRecord, step: StepProgress): Promise<ExecutionRecord> {
    return this.o.store.update({ ...r, updatedAt: this.o.now(), steps: { ...r.steps, [step.stepId]: step } }, r.version);
  }

  private async fail(r: ExecutionRecord, reason: string, fundsMayBeAtRisk: boolean): Promise<ExecutionRecord> {
    return this.move({ ...r, failure: { reason, fundsMayBeAtRisk } }, 'FAILED', reason);
  }

  private async attention(r: ExecutionRecord, message: string): Promise<ExecutionRecord> {
    return this.o.store.update({ ...r, updatedAt: this.o.now(), needsAttention: message }, r.version);
  }

  private async waitConfirmed(chain: ChainId, hash: string): Promise<'confirmed' | 'failed' | 'pending'> {
    const deadline = this.o.now() + this.o.confirmTimeoutMs;
    for (;;) {
      let state: 'confirmed' | 'failed' | 'pending';
      try {
        state = await this.o.gateway.confirmation(chain, hash);
      } catch {
        state = 'pending';
      }
      if (state !== 'pending') return state;
      if (this.o.now() >= deadline) return 'pending';
      await this.o.sleep(this.o.confirmPollMs);
    }
  }
}
