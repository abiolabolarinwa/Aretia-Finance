/**
 * AretiaProviderHealth: tracks how each piece of infrastructure (a DEX adapter, an RPC endpoint) is
 * behaving and turns that into a status. The router reads the status; nothing here decides routes.
 *
 * ACTIVE -> DEGRADED -> DISABLED, with recovery: a disabled component is retried after a cooldown
 * (shown as DEGRADED while probing) and returns to ACTIVE after a run of successes.
 */
import type { DexStatus } from './types.js';

export interface HealthOptions {
  /** Observations kept per component. */
  window?: number;
  /** Minimum observations before a failure rate means anything. */
  minSamples?: number;
  degradeAt?: number;
  disableAt?: number;
  /** Consecutive successes needed to be trusted again. */
  recoverAfter?: number;
  cooldownMs?: number;
  /** Data older than this is stale. */
  staleAfterMs?: number;
  now?: () => number;
}

interface Obs {
  ok: boolean;
  ms: number;
  at: number;
}

export interface HealthReport {
  status: DexStatus;
  samples: number;
  failureRate: number;
  p95LatencyMs: number | null;
  lastOkAt: number | null;
  reason: string;
}

export class ProviderHealth {
  private readonly obs = new Map<string, Obs[]>();
  private readonly disabledUntil = new Map<string, number>();
  private readonly o: Required<HealthOptions>;

  constructor(options: HealthOptions = {}) {
    this.o = { window: 20, minSamples: 5, degradeAt: 0.4, disableAt: 0.8, recoverAfter: 5, cooldownMs: 30_000, staleAfterMs: 120_000, now: Date.now, ...options };
  }

  record(id: string, ok: boolean, ms: number): void {
    const list = this.obs.get(id) ?? [];
    list.push({ ok, ms, at: this.o.now() });
    if (list.length > this.o.window) list.shift();
    this.obs.set(id, list);
    const report = this.report(id);
    if (report.status === 'DISABLED' && !this.disabledUntil.has(id)) this.disabledUntil.set(id, this.o.now() + this.o.cooldownMs);
    if (report.status === 'ACTIVE') this.disabledUntil.delete(id);
  }

  /** Measures an async call, records the outcome and rethrows failures unchanged. */
  async track<T>(id: string, work: () => Promise<T>): Promise<T> {
    const start = this.o.now();
    try {
      const value = await work();
      this.record(id, true, this.o.now() - start);
      return value;
    } catch (e) {
      this.record(id, false, this.o.now() - start);
      throw e;
    }
  }

  report(id: string): HealthReport {
    const list = this.obs.get(id) ?? [];
    const now = this.o.now();
    const lastOk = [...list].reverse().find((x) => x.ok)?.at ?? null;
    const failures = list.filter((x) => !x.ok).length;
    const rate = list.length === 0 ? 0 : failures / list.length;
    const lat = list.filter((x) => x.ok).map((x) => x.ms).sort((a, b) => a - b);
    const p95 = lat.length === 0 ? null : lat[Math.min(lat.length - 1, Math.floor(0.95 * lat.length))]!;
    const base = { samples: list.length, failureRate: rate, p95LatencyMs: p95, lastOkAt: lastOk };
    if (list.length < this.o.minSamples) return { ...base, status: 'ACTIVE', reason: 'Too few observations to judge.' };

    const recent = list.slice(-this.o.recoverAfter);
    const recovered = recent.length === this.o.recoverAfter && recent.every((x) => x.ok);
    const until = this.disabledUntil.get(id);
    if (rate >= this.o.disableAt && !recovered) {
      // After the cooldown the component is probed again as DEGRADED, so one success can start recovery.
      if (until !== undefined && now >= until) return { ...base, status: 'DEGRADED', reason: 'Cooling down after being disabled; being probed.' };
      return { ...base, status: 'DISABLED', reason: `${Math.round(rate * 100)}% of recent calls failed.` };
    }
    if (rate >= this.o.degradeAt && !recovered) return { ...base, status: 'DEGRADED', reason: `${Math.round(rate * 100)}% of recent calls failed.` };
    if (lastOk !== null && now - lastOk > this.o.staleAfterMs) return { ...base, status: 'DEGRADED', reason: 'No successful call recently: data may be stale.' };
    return { ...base, status: 'ACTIVE', reason: 'Healthy.' };
  }

  status(id: string): DexStatus {
    return this.report(id).status;
  }

  /** Whether a component should be tried at all right now. Disabled components are skipped until their cooldown ends. */
  usable(id: string): boolean {
    const r = this.report(id);
    return r.status !== 'DISABLED';
  }
}

/** The worse of two statuses, so a manual maintenance flag and measured health both count. */
export function worstStatus(a: DexStatus, b: DexStatus): DexStatus {
  const rank: Record<DexStatus, number> = { ACTIVE: 0, DEGRADED: 1, MAINTENANCE: 2, DISABLED: 3 };
  return rank[a] >= rank[b] ? a : b;
}
