/**
 * Swap-history backfill: reads the swaps of the past N days of a chain for the pools an adapter already holds, and stores them as trades,
 * so a pool that was quiet since the indexer started following it still has its 24-hour volume, transactions, traders and price change.
 *
 * It reuses the chain-wide swap scan (swapScan.ts: one topic-only `eth_getLogs` per block range, keeping the swaps of registered pools).
 * It walks forward from N days ago to the block where the live adapter began (its checkpoint), so the two never need to overlap, and stops there.
 * Progress is a checkpoint row `<adapter>:swaps:<days>d`, so a restart resumes; the whole walk is idempotent (trades are keyed by
 * their log), so reading a range twice stores nothing twice.
 *
 * What it does not do, on purpose, to stay cheap enough for a free node:
 *  - It does not re-read each pool's reserves per range. It only records each pool's first and last trade time; the reserves refresher
 *    (refresher.ts) then recomputes the pool's statistics from the stored trades on its next pass.
 *  - It does not read a block per swap. The time of a swap is interpolated between the block times at the two ends of its range (about
 *    a few seconds of error on a 12-second chain, and the sub-second chains' blocks are close to evenly spaced), which is far finer than
 *    anything the 5-minute to 24-hour windows or the candles show. Ranges it walks are deeper than the chain's reorg depth.
 *
 * The store keeps trades only for its retention window (default 14 days), so `days` is capped to it by the caller: reading further back
 * would be thrown away by the next prune.
 */
import { secondsPerBlock } from './backfill.js';
import type { MiChainConfig } from './chains.js';
import { tradeOf } from './decode.js';
import type { DexAdapterSpec } from './dexes.js';
import type { EngineDeps } from './engine.js';
import { getBlock, getHead } from './evmReads.js';
import type { ListingRules } from './lifecycle.js';
import { MULTICALL_CHAINS } from './reserves.js';
import { RpcError, type Read } from './rpc.js';
import type { MiStore } from './store.js';
import { scanCacheFor, scanSwaps } from './swapScan.js';
import { poolKeyOf, tokenKeyOf, type MiTrade } from './types.js';

/**
 * Blocks per request for this walk, where a chain allows far more than the live adapter's range. Robinhood Chain makes a block about every
 * 0.13 s (10 million blocks in 14 days) and its node takes 30,000 blocks per topic-only request, so the live range of 4,000 would need
 * 2,500 requests; 25,000 needs 400. Its block times stay within seconds of a straight line over such a range (checked on the live chain),
 * so the interpolation below stays accurate. Other chains use the chain's own range.
 */
export const SWAP_BACKFILL_RANGE: Readonly<Record<string, number>> = { robinhood: 25_000 };
export const swapBackfillRangeOf = (chain: Pick<MiChainConfig, 'id' | 'maxRange'>): number => Math.max(1, SWAP_BACKFILL_RANGE[chain.id] ?? chain.maxRange);

export const swapBackfillKey = (adapterId: string, days: number): string => `${adapterId}:swaps:${days}d`;

export interface SwapBackfillDeps {
  spec: DexAdapterSpec;
  chain: MiChainConfig;
  read: Read;
  store: MiStore;
  rules: ListingRules;
  now: () => number;
  budgetMs: number;
  /** How many days back to read. */
  days: number;
}

export interface SwapBackfillReport {
  adapterId: string;
  ok: boolean;
  state: 'walking' | 'done' | 'skipped';
  skipped: 'unsupported' | 'disabled' | 'no-live-checkpoint' | null;
  fromBlock: number | null;
  toBlock: number | null;
  /** Swaps of registered pools found, and how many trades were new. */
  swaps: number;
  tradesNew: number;
  error: string | null;
  durationMs: number;
}

/** Time of a block from two known blocks of the range, by straight-line interpolation (whole seconds). */
export function interpolateTime(anchor: { block: number; time: number }, end: { block: number; time: number }, block: number): number {
  if (end.block <= anchor.block) return anchor.time;
  const t = anchor.time + ((block - anchor.block) * (end.time - anchor.time)) / (end.block - anchor.block);
  return Math.round(Math.min(end.time, Math.max(anchor.time, t)));
}

export async function backfillSwaps(d: SwapBackfillDeps): Promise<SwapBackfillReport> {
  const t0 = d.now();
  const r: SwapBackfillReport = { adapterId: d.spec.id, ok: true, state: 'walking', skipped: null, fromBlock: null, toBlock: null, swaps: 0, tradesNew: 0, error: null, durationMs: 0 };
  const done = (state: SwapBackfillReport['state'], skipped: SwapBackfillReport['skipped'] = null): SwapBackfillReport => ({ ...r, state, skipped, durationMs: d.now() - t0 });
  if (d.spec.kind === 'v4' || !MULTICALL_CHAINS.includes(d.chain.id)) return done('skipped', 'unsupported');
  try {
    if ((await d.store.disabledAdapters()).has(d.spec.id)) return done('skipped', 'disabled');
    const key = swapBackfillKey(d.spec.id, d.days);
    let cp = await d.store.getCheckpoint(key);
    if (cp?.blockHash === 'done') return done('done');
    const live = await d.store.getCheckpoint(d.spec.id);
    if (!live) return done('skipped', 'no-live-checkpoint');
    const head = await getHead(d.read);
    const end = Math.min(head - d.chain.confirmations, live.block);
    if (!cp) {
      const spb = await secondsPerBlock(d.read, head);
      const start = Math.max(0, end - Math.round((d.days * 86_400) / spb));
      cp = { adapterId: key, block: start - 1, blockHash: 'walking', updatedAt: d.now() };
      await d.store.setCheckpoint(cp);
    }
    let from = cp.block + 1;
    r.fromBlock = from;
    const deadline = t0 + d.budgetMs;
    const engine: EngineDeps = { spec: d.spec, chain: d.chain, read: d.read, store: d.store, rules: d.rules, now: d.now, swapScan: true };
    const cache = scanCacheFor(d.spec.id);
    const blockTime = async (n: number): Promise<{ block: number; time: number }> => {
      const b = await getBlock(d.read, n);
      if (!b) throw new RpcError(`block ${n} could not be read`, 'transport');
      return { block: n, time: b.time };
    };
    let anchor = from <= end ? await blockTime(from) : null;
    while (from <= end && d.now() < deadline) {
      const to = Math.min(from + swapBackfillRangeOf(d.chain) - 1, end);
      const tip = to === anchor!.block ? anchor! : await blockTime(to);
      const hits = await scanSwaps(engine, from, to, cache);
      const trades: MiTrade[] = [];
      const span = new Map<string, { first: number; last: number; pool: string }>();
      for (const { swap: s, pool } of hits) {
        const t = tradeOf(pool, s, interpolateTime(anchor!, tip, s.block));
        r.swaps++;
        if (!t) continue;
        trades.push(t);
        const seen = span.get(pool.address);
        if (seen) {
          seen.first = Math.min(seen.first, t.time);
          seen.last = Math.max(seen.last, t.time);
        } else span.set(pool.address, { first: t.time, last: t.time, pool: pool.address });
      }
      if (trades.length > 0) r.tradesNew += await d.store.putTrades(d.spec.id, trades);
      await markPools(d.store, d.spec.chain, span);
      cp = { adapterId: key, block: to, blockHash: 'walking', updatedAt: d.now() };
      await d.store.setCheckpoint(cp);
      r.toBlock = to;
      anchor = tip;
      from = to + 1;
    }
    if (from > end) {
      await d.store.setCheckpoint({ adapterId: key, block: end, blockHash: 'done', updatedAt: d.now() });
      return done('done');
    }
  } catch (e) {
    r.ok = false;
    r.error = (e instanceof Error ? e.message : 'the swap backfill failed').slice(0, 300);
  }
  return done('walking');
}

/**
 * Widens each pool's first/last trade time to include the backfilled trades. The pools are read fresh (not from the scan's memory) so a
 * live trade written meanwhile is never moved backwards, and a write is made only when something moved.
 */
async function markPools(store: MiStore, chain: DexAdapterSpec['chain'], span: Map<string, { first: number; last: number; pool: string }>): Promise<void> {
  if (span.size === 0) return;
  const fresh = await store.getPools([...span.keys()].map((a) => poolKeyOf(chain, a)));
  for (const p of fresh.values()) {
    const s = span.get(p.address);
    if (!s) continue;
    const first = p.firstTradeAt === null ? s.first * 1000 : Math.min(p.firstTradeAt, s.first * 1000);
    const last = p.lastTradeAt === null ? s.last * 1000 : Math.max(p.lastTradeAt, s.last * 1000);
    if (first === p.firstTradeAt && last === p.lastTradeAt) continue;
    await store.updatePool(p.key, { firstTradeAt: first, lastTradeAt: last });
    if (first !== p.firstTradeAt) await store.setTokenFirstTrade(tokenKeyOf(chain, p.base), first);
  }
}
