/**
 * Observability and analytics for Swings. One small, dependency-free module:
 *  - typed events with a redaction pass, so secrets cannot be logged by accident;
 *  - counters and latency summaries (quote failures, provider failures, route selection, swap outcomes);
 *  - aggregate analytics with no personal data: wallet addresses are never recorded.
 *
 * It only keeps data in memory for the session. Nothing is sent anywhere: a server sink would be a
 * separate, reviewed addition (see docs/aretia-swings/production-readiness.md).
 */
import type { ChainId, SwapExecution } from '../core/types.js';
import type { RouterEvent } from '../router/router.js';

/** Field names that are never recorded, whatever their value. */
const SECRET_KEYS = /seed|mnemonic|passphrase|password|private|secret|keypair|signature|signed|apikey|api_key|authorization|token$/i;
const LONG_SECRETISH = /^(?:[A-Za-z0-9+/=_-]{80,}|0x[0-9a-fA-F]{80,})$/;

/** Returns a copy that is safe to log: secret-named fields removed, long opaque strings and addresses masked. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (typeof value === 'string') return LONG_SECRETISH.test(value) ? '[redacted blob]' : value.length > 300 ? value.slice(0, 300) + '…' : value;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}

export type TelemetryEvent =
  | { name: 'quote_failed'; provider: string; message: string }
  | { name: 'quote_rejected'; provider: string; reasons: string[] }
  | { name: 'routes_found'; chain: ChainId; count: number; best: string | null; ms: number }
  | { name: 'shadow'; chain: ChainId; provider: string; rival: string; diff: number }
  | { name: 'swap'; chain: ChainId; provider: string; status: SwapExecution['status']; ms: number }
  | { name: 'rpc_failed'; chain: ChainId; method: string }
  | { name: 'token_indexed'; chain: ChainId; count: number }
  | { name: 'token_index_failed'; chain: ChainId; message: string }
  | { name: 'risk_assessed'; chain: ChainId; status: string }
  | { name: 'risk_failed'; chain: ChainId };

export interface LoggedEvent {
  at: number;
  event: Record<string, unknown>;
}

/** Where events go. The default keeps a bounded in-memory buffer; tests and future server sinks implement this. */
export interface TelemetrySink {
  write(entry: LoggedEvent): void;
}

export class Telemetry {
  private readonly buffer: LoggedEvent[] = [];
  readonly counters = new Map<string, number>();
  private readonly latencies = new Map<string, number[]>();

  constructor(
    private readonly sinks: TelemetrySink[] = [],
    private readonly now: () => number = Date.now,
    private readonly capacity = 500,
  ) {}

  record(event: TelemetryEvent): void {
    const safe = redact(event) as Record<string, unknown>;
    const entry: LoggedEvent = { at: this.now(), event: safe };
    this.buffer.push(entry);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    this.bump(event.name);
    if ('provider' in event) this.bump(`${event.name}:${event.provider}`);
    if ('chain' in event) this.bump(`${event.name}:${event.chain}`);
    if ('ms' in event) {
      const key = `${event.name}${'provider' in event ? ':' + event.provider : ''}`;
      const list = this.latencies.get(key) ?? [];
      list.push(event.ms);
      if (list.length > 200) list.shift();
      this.latencies.set(key, list);
    }
    for (const sink of this.sinks) {
      try {
        sink.write(entry);
      } catch {
        // A broken sink must never break a swap.
      }
    }
  }

  count(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  /** Median and 95th percentile of recorded durations for a key such as `swap:jupiter`. */
  latency(key: string): { n: number; p50: number; p95: number } | null {
    const list = this.latencies.get(key);
    if (!list || list.length === 0) return null;
    const sorted = [...list].sort((a, b) => a - b);
    const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
    return { n: sorted.length, p50: at(0.5), p95: at(0.95) };
  }

  recent(limit = 50): LoggedEvent[] {
    return this.buffer.slice(-limit);
  }

  private bump(key: string): void {
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }
}

export interface SwapAnalytics {
  swaps: { total: number; confirmed: number; failed: number; rejected: number; submitted: number };
  byChain: Record<string, number>;
  /** How often each provider's route was the one shown first. */
  routeSelection: Record<string, number>;
  providers: Record<string, { quoteFailures: number; quoteRejections: number; swaps: number; failedSwaps: number }>;
  /** Median seconds from signature request to a settled status, if any swap settled. */
  medianExecutionSeconds: number | null;
}

/** Aggregates only: no addresses, amounts or token identities leave this function. */
export function summarize(t: Telemetry): SwapAnalytics {
  const events = t.recent(500).map((e) => e.event);
  const out: SwapAnalytics = { swaps: { total: 0, confirmed: 0, failed: 0, rejected: 0, submitted: 0 }, byChain: {}, routeSelection: {}, providers: {}, medianExecutionSeconds: null };
  const prov = (id: string) => (out.providers[id] ??= { quoteFailures: 0, quoteRejections: 0, swaps: 0, failedSwaps: 0 });
  const durations: number[] = [];
  for (const e of events) {
    const provider = typeof e.provider === 'string' ? e.provider : null;
    if (e.name === 'quote_failed' && provider) prov(provider).quoteFailures++;
    else if (e.name === 'quote_rejected' && provider) prov(provider).quoteRejections++;
    else if (e.name === 'routes_found' && typeof e.best === 'string') out.routeSelection[e.best] = (out.routeSelection[e.best] ?? 0) + 1;
    else if (e.name === 'swap' && provider) {
      const status = e.status as keyof SwapAnalytics['swaps'];
      out.swaps.total++;
      if (status in out.swaps) out.swaps[status]++;
      prov(provider).swaps++;
      if (status === 'failed') prov(provider).failedSwaps++;
      if (typeof e.chain === 'string') out.byChain[e.chain] = (out.byChain[e.chain] ?? 0) + 1;
      if ((status === 'confirmed' || status === 'failed') && typeof e.ms === 'number') durations.push(e.ms);
    }
  }
  if (durations.length > 0) {
    durations.sort((a, b) => a - b);
    out.medianExecutionSeconds = durations[Math.floor(durations.length / 2)]! / 1000;
  }
  return out;
}

/**
 * Bridges router events into telemetry. Quote timing is measured from the first event of a search;
 * swap timing from the signature request to the settled status. Only provider ids, chain ids and
 * statuses are recorded.
 */
export function routerEventSink(t: Telemetry, providerOf: (quoteId: string) => string, now: () => number = Date.now): (e: RouterEvent) => void {
  const started = new Map<string, number>();
  let searchStart = now();
  return (e) => {
    if (e.type === 'quote-failed') t.record({ name: 'quote_failed', provider: e.providerId, message: e.message });
    else if (e.type === 'quote-rejected') t.record({ name: 'quote_rejected', provider: e.providerId, reasons: e.reasons });
    else if (e.type === 'shadow') t.record({ name: 'shadow', chain: e.chain, provider: e.winner, rival: e.rival, diff: e.diffBps });
    else if (e.type === 'routes-found') {
      t.record({ name: 'routes_found', chain: e.chain, count: e.count, best: e.bestProvider, ms: now() - searchStart });
      searchStart = now();
    } else if (e.type === 'execution') {
      const x = e.execution;
      if (x.status === 'awaiting-signature') started.set(x.id, x.startedAt);
      else t.record({ name: 'swap', chain: x.chain, provider: providerOf(x.quoteId), status: x.status, ms: x.updatedAt - (started.get(x.id) ?? x.startedAt) });
    }
  };
}
