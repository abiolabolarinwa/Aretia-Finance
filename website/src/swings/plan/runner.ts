/**
 * Runs a plan one safe step at a time. `step()` is idempotent and cheap: call it as often as the screen likes. It never
 * sends anything itself; each leg's executor does that (the settlement executor wraps the milestone-34 orchestrator,
 * the ramp executor watches the wallet, the swap executor hands over to the swap screen).
 *
 * What it guarantees: legs run strictly in order; a leg is started once; a failed leg stops the plan (no later leg runs
 * on funds that did not arrive); an executor that throws changes nothing and the plan waits for the next call.
 */
import { SwingsError } from '../core/types.js';
import type { LegKind } from './executionQuote.js';
import { hasBegun, isPlanFinal, movePlan, newPlan, type LegRef, type PlanLeg, type PlanRecord } from './state.js';
import type { ExecutionQuote } from './executionQuote.js';
import type { JsonVersionedStore } from './store.js';

export type LegProgress =
  | { status: 'active'; ref?: LegRef }
  | { status: 'waiting-user'; instruction: string; ref?: LegRef }
  | { status: 'needs-requote'; instruction: string }
  | { status: 'done'; ref?: LegRef }
  | { status: 'failed'; reason: string; fundsMayBeAtRisk: boolean; ref?: LegRef };

export interface LegExecutor {
  /** Begins the leg. Called once, when the previous leg is done. */
  start(plan: PlanRecord, leg: PlanLeg): Promise<LegProgress>;
  /** Asks where the leg is. Called on every later step until the leg is done or failed. */
  poll(plan: PlanRecord, leg: PlanLeg): Promise<LegProgress>;
}

export interface RunnerOptions {
  store: JsonVersionedStore<PlanRecord>;
  executors: Partial<Record<LegKind, LegExecutor>>;
  now?: () => number;
  newId?: () => string;
}

export class PlanRunner {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly busy = new Set<string>();

  constructor(private readonly o: RunnerOptions) {
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? (() => `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  }

  async create(quote: ExecutionQuote): Promise<PlanRecord> {
    if (quote.expiresAt <= this.now()) throw new SwingsError('expired', 'This quote has expired. Get a new one.');
    for (const l of quote.legs) if (!this.o.executors[l.kind]) throw new SwingsError('invalid', `Aretia cannot carry out a "${l.kind}" step here, so this plan is not created.`);
    return this.o.store.create(newPlan(this.newId(), quote, this.now()));
  }

  async cancel(id: string): Promise<PlanRecord> {
    const p = await this.require(id);
    return this.save(p, movePlan(p, 'CANCELLED', 'Cancelled before anything began.', this.now()));
  }

  /** Moves the plan as far as it safely can right now. */
  async step(id: string): Promise<PlanRecord> {
    if (this.busy.has(id)) throw new SwingsError('invalid', 'This plan is already being worked on.');
    this.busy.add(id);
    try {
      let p = await this.require(id);
      if (isPlanFinal(p.state)) return p;
      if (p.state === 'PLANNED') {
        if (!hasBegun(p) && p.quote.expiresAt <= this.now()) return this.save(p, movePlan(p, 'EXPIRED', 'The quote expired before anything began.', this.now()));
        p = await this.save(p, movePlan(p, 'RUNNING', 'Started.', this.now()));
      } else if (p.state === 'WAITING_USER') p = await this.save(p, movePlan(p, 'RUNNING', 'Checking again.', this.now()));

      for (let guard = 0; guard < p.legs.length + 2; guard++) {
        const leg = p.legs.find((l) => l.status !== 'done');
        if (!leg) return this.save(p, movePlan(p, 'COMPLETED', 'Every step is done.', this.now()));
        const exec = this.o.executors[leg.kind];
        if (!exec) return this.fail(p, leg, `No way to carry out a "${leg.kind}" step.`, false);
        let progress: LegProgress;
        try {
          progress = leg.status === 'pending' ? await exec.start(p, leg) : await exec.poll(p, leg);
        } catch (e) {
          // An executor that throws changes nothing. The plan waits and is asked again next time.
          return this.save(p, movePlan(p, 'WAITING_USER', e instanceof Error ? e.message : 'The step could not be checked.', this.now()), leg.index, { status: leg.status === 'pending' ? 'pending' : leg.status, instruction: 'Could not check this step just now. Try again shortly.' });
        }
        if (progress.status === 'failed') return this.fail(p, leg, progress.reason, progress.fundsMayBeAtRisk, progress.ref);
        if (progress.status === 'done') {
          p = await this.save(p, p, leg.index, { status: 'done', instruction: null, doneAt: this.now(), ref: progress.ref });
          continue; // the next leg may start straight away
        }
        if (progress.status === 'active') {
          p = await this.save(p, p, leg.index, { status: 'active', instruction: null, ref: progress.ref });
          return p;
        }
        const instruction = progress.instruction;
        p = await this.save(p, p, leg.index, { status: progress.status, instruction, ref: 'ref' in progress ? progress.ref : undefined });
        return this.save(p, movePlan(p, 'WAITING_USER', instruction, this.now()));
      }
      return p;
    } finally {
      this.busy.delete(id);
    }
  }

  private async fail(p: PlanRecord, leg: PlanLeg, reason: string, risk: boolean, ref?: LegRef): Promise<PlanRecord> {
    const marked = await this.save(p, p, leg.index, { status: 'failed', instruction: null, ref });
    return this.save(marked, { ...movePlan(marked, 'FAILED', reason, this.now()), failure: { reason, fundsMayBeAtRisk: risk, legIndex: leg.index } });
  }

  private async require(id: string): Promise<PlanRecord> {
    const p = await this.o.store.get(id);
    if (!p) throw new SwingsError('invalid', 'That plan was not found.');
    return p;
  }

  /** Saves `next`, optionally updating one leg first. */
  private async save(current: PlanRecord, next: PlanRecord, legIndex?: number, patch?: Partial<PlanLeg> & { status: PlanLeg['status'] }): Promise<PlanRecord> {
    let record = next;
    if (legIndex !== undefined && patch) {
      const t = this.now();
      record = { ...next, updatedAt: t, legs: next.legs.map((l) => (l.index === legIndex ? { ...l, ...patch, ref: patch.ref ? { ...l.ref, ...patch.ref } : l.ref, startedAt: l.startedAt ?? t } : l)) };
    }
    return this.o.store.update(record, current.version);
  }
}
