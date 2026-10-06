/**
 * Token discovery: one worker shape for all five chains. A DiscoverySource knows how to ask one place
 * (an indexer API, an RPC feed) "what is new since this cursor?" for one chain; the worker does the
 * rest identically: ingest, enrich with risk facts, advance the cursor.
 *
 * Guarantees:
 *  - At-least-once: the cursor moves only after the batch was handled, and ingest is idempotent.
 *  - A source failure leaves the cursor where it was and is reported, never swallowed.
 *  - "New" is never invented: `firstDetectedAt` is when this worker saw the token; creation and
 *    first-pool times are stored only when the source supplied them.
 */
import type { ChainId } from '../core/types.js';
import type { TokenCandidate, TokenRegistryService, TokenRepository } from './registry.js';
import type { TokenRisk } from '../core/types.js';

export interface DiscoveryBatch {
  candidates: TokenCandidate[];
  /** Opaque position to resume from; null leaves the cursor unchanged. */
  nextCursor: string | null;
}

export interface DiscoverySource {
  readonly id: string;
  readonly chain: ChainId;
  poll(cursor: string | null, signal?: AbortSignal): Promise<DiscoveryBatch>;
}

/** Adds on-chain facts and a risk assessment to a stored token. Optional; a failure here does not lose the token. */
export interface TokenEnricher {
  enrich(candidate: TokenCandidate): Promise<{ risk: TokenRisk; metadata: Record<string, string | number | boolean | null>; decimals?: number } | null>;
}

export interface WorkerRun {
  source: string;
  chain: ChainId;
  polled: number;
  ingested: number;
  rejected: number;
  enrichFailures: number;
  error: string | null;
  ranAt: number;
}

export class TokenDiscoveryWorker {
  constructor(
    private readonly source: DiscoverySource,
    private readonly registry: TokenRegistryService,
    private readonly repo: TokenRepository,
    private readonly enricher: TokenEnricher | null = null,
    private readonly now: () => number = Date.now,
    private readonly maxPerRun = 100,
  ) {}

  async runOnce(signal?: AbortSignal): Promise<WorkerRun> {
    const run: WorkerRun = { source: this.source.id, chain: this.source.chain, polled: 0, ingested: 0, rejected: 0, enrichFailures: 0, error: null, ranAt: this.now() };
    let batch: DiscoveryBatch;
    try {
      batch = await this.source.poll(await this.repo.getCursor(this.source.id), signal);
    } catch (e) {
      run.error = e instanceof Error ? e.message : 'The discovery source failed.';
      return run;
    }
    const candidates = batch.candidates.slice(0, this.maxPerRun);
    run.polled = candidates.length;
    for (const c of candidates) {
      // A source may only report tokens on its own chain: anything else is dropped, not re-labelled.
      if (c.ref.chain !== this.source.chain) {
        run.rejected++;
        continue;
      }
      const record = await this.registry.ingest(c);
      if (!record) {
        run.rejected++;
        continue;
      }
      run.ingested++;
      if (this.enricher) {
        try {
          const enriched = await this.enricher.enrich(c);
          if (enriched) {
            if (enriched.decimals !== undefined) await this.registry.ingest({ ref: c.ref, decimals: enriched.decimals, onchain: true, source: c.source });
            await this.registry.attachRisk(record.ref, enriched.risk, enriched.metadata);
          }
        } catch {
          run.enrichFailures++;
        }
      }
    }
    // Only a fully handled batch advances the cursor. A truncated batch is re-polled next time.
    if (batch.nextCursor !== null && candidates.length === batch.candidates.length) await this.repo.setCursor(this.source.id, batch.nextCursor);
    return run;
  }
}
