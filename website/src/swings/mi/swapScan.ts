/**
 * Chain-wide swap reading. The engine normally follows the swaps of a bounded set of pools by address (10 addresses per getLogs call on
 * a public node), which cannot cover thousands of pools. A V2 or V3 pool announces every swap with the same event, so one request for
 * that event across the WHOLE chain returns the swaps of every pool at once. This reads them that way and keeps only the swaps of pools
 * this adapter has registered; everything else (other forks and unlisted dust pools that share the event) is dropped.
 *
 * Nothing is invented: trades are decoded and stored exactly as on the by-address path (same decoder, same trade shape, same checks).
 * Switched on per chain with MI_SWAP_SCAN (comma-separated chain names); off by default. What a node returns for such a request is
 * bounded by its own limits (a result-size cap answers with an error, and the range is then halved by `getLogsHalving`).
 */
import type { EngineDeps } from './engine.js';
import { decodeSwap, type RawSwap } from './decode.js';
import { getLogsHalving } from './evmReads.js';
import { FOLLOWED_STATES } from './lifecycle.js';
import type { MiPool } from './types.js';
import { poolKeyOf } from './types.js';

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** What is remembered about a pool address seen in a swap: the registered pool, or null for one this adapter does not hold. */
export interface ScanCache {
  pools: Map<string, { pool: MiPool | null; at: number }>;
}

/** A pool address that is not ours is asked about again after this long (a backfill may have registered it meanwhile). */
export const SCAN_MISS_TTL_MS = 10 * 60_000;
/** A registered pool is re-read after this long. */
export const SCAN_HIT_TTL_MS = 5 * 60_000;
/** Most addresses remembered per adapter; the memory is cleared when it is exceeded. */
export const SCAN_CACHE_MAX = 50_000;

const caches = new Map<string, ScanCache>();
/** The memory of one adapter, kept between runs of a long-lived process. */
export function scanCacheFor(adapterId: string): ScanCache {
  let c = caches.get(adapterId);
  if (!c) caches.set(adapterId, (c = { pools: new Map() }));
  return c;
}

/** The chains named by MI_SWAP_SCAN ("ethereum,base"). Empty when unset. */
export function swapScanChains(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export interface ScanReport {
  logs: number;
  swaps: number;
  ours: number;
  lookups: number;
}

/**
 * The swaps in blocks `from..to` of this adapter's registered pools, in block order, each with its pool. Only V2 and V3 style adapters.
 * A pool counts when it belongs to this adapter, is in a followed state and existed by `to`.
 */
export async function scanSwaps(d: EngineDeps, from: number, to: number, cache: ScanCache, report?: ScanReport): Promise<{ swap: RawSwap; pool: MiPool }[]> {
  if (d.spec.kind === 'v4') return [];
  const logs = await getLogsHalving(d.read, { topics: [d.spec.swapTopic] }, from, to);
  const swaps: RawSwap[] = [];
  for (const raw of logs) {
    const s = decodeSwap(raw, d.spec.kind, d.spec.swapTopic);
    if (s && ADDRESS.test(s.pool) && s.block >= from && s.block <= to) swaps.push(s);
  }
  const now = d.now();
  const unknown: string[] = [];
  for (const a of new Set(swaps.map((s) => s.pool))) {
    const hit = cache.pools.get(a);
    if (!hit || now - hit.at >= (hit.pool ? SCAN_HIT_TTL_MS : SCAN_MISS_TTL_MS)) unknown.push(a);
  }
  if (cache.pools.size + unknown.length > SCAN_CACHE_MAX) cache.pools.clear();
  if (unknown.length > 0) {
    const found = await d.store.getPools(unknown.map((a) => poolKeyOf(d.spec.chain, a)));
    for (const a of unknown) {
      const p = found.get(poolKeyOf(d.spec.chain, a));
      cache.pools.set(a, { pool: p && p.adapterId === d.spec.id && !p.paused && FOLLOWED_STATES.includes(p.state) ? p : null, at: now });
    }
  }
  const out: { swap: RawSwap; pool: MiPool }[] = [];
  for (const s of swaps) {
    const pool = cache.pools.get(s.pool)?.pool;
    if (pool && pool.createdBlock <= to) out.push({ swap: s, pool });
  }
  out.sort((a, b) => a.swap.block - b.swap.block || a.swap.logIndex - b.swap.logIndex);
  if (report) {
    report.logs += logs.length;
    report.swaps += swaps.length;
    report.ours += out.length;
    report.lookups += unknown.length;
  }
  return out;
}
