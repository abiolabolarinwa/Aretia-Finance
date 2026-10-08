/**
 * Observability for the cross-chain and plan layers. It records WHAT happened (a state changed, a move failed, a
 * provider declined) and never WHO or WITH WHAT: no wallet addresses, no transaction hashes, no amounts, no links, no
 * payment details and nothing secret. Ids are Aretia's own random record ids.
 *
 * It sits around the stores, so every state change is seen exactly once whatever code made it, and a broken sink can
 * never break an execution (the Telemetry class already guards that).
 */
import type { ExecutionRecord } from '../orchestrator/states.js';
import type { ExecutionStore } from '../orchestrator/store.js';
import type { PlanRecord } from '../plan/state.js';
import { JsonVersionedStore } from '../plan/store.js';
import type { RecoveryItem } from '../plan/recovery.js';
import type { RampSearch } from '../ramp/router.js';
import type { SettlementSearch } from '../settlement/engine.js';
import type { ChainId } from '../core/types.js';
import type { Telemetry } from './telemetry.js';

export function observeExecutionChange(t: Telemetry, prev: ExecutionRecord | null, next: ExecutionRecord): void {
  if (prev && prev.state !== next.state) t.record({ name: 'execution_state', kind: 'settlement', id: next.id, from: prev.state, to: next.state, ms: next.updatedAt - prev.updatedAt });
  if (next.state === 'FAILED' && prev?.state !== 'FAILED') t.record({ name: 'execution_failed', kind: 'settlement', id: next.id, reason: next.failure?.reason ?? 'failed', fundsMayBeAtRisk: next.failure?.fundsMayBeAtRisk ?? true });
}

export function observePlanChange(t: Telemetry, prev: PlanRecord | null, next: PlanRecord): void {
  if (prev && prev.state !== next.state) t.record({ name: 'execution_state', kind: 'plan', id: next.id, from: prev.state, to: next.state, ms: next.updatedAt - prev.updatedAt });
  if (next.state === 'FAILED' && prev?.state !== 'FAILED') t.record({ name: 'execution_failed', kind: 'plan', id: next.id, reason: next.failure?.reason ?? 'failed', fundsMayBeAtRisk: next.failure?.fundsMayBeAtRisk ?? true });
}

/** An execution store that reports each state change to telemetry. */
export function observedExecutionStore(inner: ExecutionStore, t: Telemetry): ExecutionStore {
  return {
    get: (id) => inner.get(id),
    list: () => inner.list(),
    create: async (r) => {
      const saved = await inner.create(r);
      observeExecutionChange(t, null, saved);
      return saved;
    },
    update: async (r, v) => {
      const prev = await inner.get(r.id);
      const saved = await inner.update(r, v);
      observeExecutionChange(t, prev, saved);
      return saved;
    },
  };
}

/** A plan store that reports each state change to telemetry. */
export class ObservedPlanStore extends JsonVersionedStore<PlanRecord> {
  constructor(
    private readonly inner: JsonVersionedStore<PlanRecord>,
    private readonly t: Telemetry,
  ) {
    super(null, 'unused', (v): v is PlanRecord => typeof v === 'object');
  }
  override get(id: string): Promise<PlanRecord | null> {
    return this.inner.get(id);
  }
  override list(): Promise<PlanRecord[]> {
    return this.inner.list();
  }
  override async create(r: PlanRecord): Promise<PlanRecord> {
    const saved = await this.inner.create(r);
    observePlanChange(this.t, null, saved);
    return saved;
  }
  override async update(r: PlanRecord, v: number): Promise<PlanRecord> {
    const prev = await this.inner.get(r.id);
    const saved = await this.inner.update(r, v);
    observePlanChange(this.t, prev, saved);
    return saved;
  }
}

export function observeSettlementSearch(t: Telemetry, chain: ChainId, search: SettlementSearch, ms: number): void {
  t.record({ name: 'settlement_quote', provider: search.quotes[0]?.providerId ?? 'none', chain, found: search.quotes.length, declined: search.declined.length, failed: search.failures.length, ms });
}

export function observeRampSearch(t: Telemetry, chain: ChainId, side: string, search: RampSearch): void {
  for (const q of search.quotes) t.record({ name: 'ramp_options', provider: q.providerId, chain, side, offered: true, reason: null });
  for (const d of search.declined) t.record({ name: 'ramp_options', provider: d.providerId, chain, side, offered: false, reason: d.reason });
  for (const f of search.failures) t.record({ name: 'ramp_options', provider: f.providerId, chain, side, offered: false, reason: f.message });
}

export function observeRecovery(t: Telemetry, items: readonly RecoveryItem[]): void {
  for (const i of items) t.record({ name: 'recovery_flagged', kind: i.subject.kind === 'plan' ? 'plan' : 'settlement', id: i.subject.id, severity: i.severity });
}
