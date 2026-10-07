/**
 * Records every swap on a followed Solana pool, from finalized transactions, into the swap store.
 *
 * Reading: the signatures that touched the pool's quote vault, newest first, back to the last one seen; then each
 * transaction at `finalized` commitment, decoded by `decodeSolanaSwap` from the pool vaults' balance changes. The vault is
 * listed rather than the pool account because busy pools are named, read-only, in a flood of price-checking transactions
 * that move no tokens; only transactions that moved tokens in or out of the pool touch its vault.
 *
 * Safety properties:
 *  - only finalized transactions, so a fork cannot remove a swap after it was stored;
 *  - the store is idempotent, so re-reading is harmless, and the cursor moves only after the batch was fetched and
 *    stored: a request that fails outright leaves the cursor where it was and the next poll tries again;
 *  - a finalized transaction the node answers "not found" for is retried a few times, and if it is still missing it is
 *    skipped and counted as `unavailable`, so one missing transaction cannot stall a pool forever;
 *  - a pool busier than one poll can read (more signatures than `maxPages` pages) is reported as `truncated`, with the
 *    gap, instead of being hidden.
 */
import type { SolRpc } from '../solana/raydiumCpmm.js';
import { decodeSolanaSwap, type ParsedTx, type SwapRecord, type SwapStore, type TrackedPool } from '../store/swaps.js';

export interface SwapIndexRun {
  signatures: number;
  swaps: number;
  stored: number;
  /** More activity arrived than one poll could read, so the oldest part of it was skipped. */
  truncated: boolean;
  /** Finalized transactions the node could not produce even after retries: a possible gap, reported rather than hidden. */
  unavailable: number;
}

export interface SwapIndexerOptions {
  /** Signatures per page of the signature list. */
  pageSize?: number;
  /** Pages read in one poll. */
  maxPages?: number;
  /** Transactions fetched at once. */
  concurrency?: number;
  /** Extra attempts for a transaction the node says it does not have, and the wait before each. */
  retries?: number;
  retryDelayMs?: number;
}

interface SigInfo {
  signature: string;
  err: unknown;
}

export class SolanaSwapIndexer {
  private readonly o: Required<SwapIndexerOptions>;

  constructor(
    private readonly rpc: SolRpc,
    private readonly store: SwapStore,
    options: SwapIndexerOptions = {},
  ) {
    this.o = { pageSize: 100, maxPages: 5, concurrency: 6, retries: 3, retryDelayMs: 500, ...options };
  }

  async poll(pool: TrackedPool): Promise<SwapIndexRun> {
    const until = (await this.store.getCursor(pool.chain, pool.pool)) ?? undefined;
    const feed = pool.quoteVault ?? pool.pool;
    const sigs: SigInfo[] = [];
    let before: string | undefined;
    let reachedCursor = false;
    for (let page = 0; page < this.o.maxPages; page++) {
      const params: { limit: number; commitment: string; before?: string; until?: string } = { limit: this.o.pageSize, commitment: 'finalized' };
      if (before) params.before = before;
      if (until) params.until = until;
      const got = await this.rpc<SigInfo[]>('getSignaturesForAddress', [feed, params]);
      sigs.push(...got);
      if (got.length < this.o.pageSize) {
        reachedCursor = true; // a short page is the end of the list, which is the cursor (or the pool's first transaction)
        break;
      }
      before = got[got.length - 1]!.signature;
    }
    const wanted = sigs.filter((s) => s.err === null || s.err === undefined);
    const swaps: SwapRecord[] = [];
    let unavailable = 0;
    for (let i = 0; i < wanted.length; i += this.o.concurrency) {
      const chunk = await Promise.all(
        wanted.slice(i, i + this.o.concurrency).map(async (s) => {
          let tx: ParsedTx | null = null;
          for (let attempt = 0; attempt <= this.o.retries; attempt++) {
            tx = await this.rpc<ParsedTx | null>('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'finalized' }]);
            if (tx !== null) break;
            if (attempt < this.o.retries) await new Promise((r) => setTimeout(r, this.o.retryDelayMs * (attempt + 1)));
          }
          if (tx === null) {
            unavailable++;
            return null;
          }
          return decodeSolanaSwap(tx, s.signature, pool);
        }),
      );
      for (const r of chunk) if (r) swaps.push(r);
    }
    const stored = await this.store.put(swaps);
    if (sigs.length > 0) await this.store.setCursor(pool.chain, pool.pool, sigs[0]!.signature);
    return { signatures: sigs.length, swaps: swaps.length, stored, truncated: !reachedCursor, unavailable };
  }
}
