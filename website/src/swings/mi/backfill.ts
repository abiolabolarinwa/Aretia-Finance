/**
 * Pool backfill: walks one factory's creation events back N days and registers the pools that hold real liquidity.
 *
 * Reading every creation of a busy factory is cheap (one getLogs per range, no per-pool call), but registering each pool is not
 * (token facts, reserves). So candidates are filtered first from the log alone (one side must be a recognised quote token), then their
 * reserves are read in batches through Multicall3, and only pools above the liquidity floor are registered with the engine's own
 * `registerPool`. A pool whose dollar liquidity cannot be known (quote token with no known dollar price) is not registered by the backfill.
 *
 * Progress is a checkpoint row `<adapter>:backfill:<days>d` in the same table the engine uses, so a restart resumes. The walk is
 * idempotent (a registered pool is never registered twice), so it can overlap what the live adapter already read.
 * No trade is created here: a backfilled pool has liquidity but no price change or volume until trades are stored for it.
 */
import type { MiChainConfig } from './chains.js';
import { decodeCreation, type Creation } from './decode.js';
import type { DexAdapterSpec } from './dexes.js';
import { readAnyToken, registerPool, type EngineDeps, type LaunchLookup, type RunReport } from './engine.js';
import { getBlock, getHead, getLogsHalving, type TokenFacts } from './evmReads.js';
import type { ListingRules } from './lifecycle.js';
import { liquidityUsdOf, MULTICALL_CHAINS, quoteUsdFor, readReservesBatch, type ReserveQuery } from './reserves.js';
import { RpcError, type Read } from './rpc.js';
import type { MiStore } from './store.js';
import { poolKeyOf } from './types.js';

export interface BackfillDeps {
  spec: DexAdapterSpec;
  chain: MiChainConfig;
  read: Read;
  store: MiStore;
  rules: ListingRules;
  now: () => number;
  nativeUsd?: () => Promise<number | null>;
  launch?: LaunchLookup | null;
  budgetMs: number;
  /** How many days back to walk. */
  days: number;
  /** Pools below this dollar liquidity are not registered (default: the listing rule's minimum). */
  minLiquidityUsd?: number;
  /** Candidates whose reserves are read per node request (default 150). */
  batch?: number;
}

export interface BackfillReport {
  adapterId: string;
  ok: boolean;
  state: 'walking' | 'done' | 'skipped';
  skipped: 'unsupported' | 'disabled' | null;
  fromBlock: number | null;
  toBlock: number | null;
  creations: number;
  candidates: number;
  registered: number;
  belowFloor: number;
  unpriced: number;
  error: string | null;
  durationMs: number;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
export const backfillKey = (adapterId: string, days: number): string => `${adapterId}:backfill:${days}d`;

/** Which side of a pair is the quote: the recognised token, a dollar stablecoin winning over the wrapped coin (same rule as the engine). */
export function sideOf(chain: MiChainConfig, t0: string, t1: string): { quote: string; base: string; baseIsToken0: boolean } | null {
  const q0 = chain.quoteTokens.find((q) => q.address === t0);
  const q1 = chain.quoteTokens.find((q) => q.address === t1);
  if (!q0 && !q1) return null;
  const quoteIsToken1 = q0 && q1 ? q1.role === 'usd' || q0.role !== 'usd' : !q0;
  return quoteIsToken1 ? { quote: t1, base: t0, baseIsToken0: true } : { quote: t0, base: t1, baseIsToken0: false };
}

/** Average seconds per block over the last `span` blocks, from two block times. */
async function secondsPerBlock(read: Read, head: number): Promise<number> {
  const span = Math.min(50_000, Math.max(1, head - 1));
  const [a, b] = await Promise.all([getBlock(read, head), getBlock(read, head - span)]);
  if (!a || !b || a.time <= b.time) throw new RpcError('block times could not be read', 'transport');
  return (a.time - b.time) / span;
}

export async function backfillCreations(d: BackfillDeps): Promise<BackfillReport> {
  const t0 = d.now();
  const r: BackfillReport = { adapterId: d.spec.id, ok: true, state: 'walking', skipped: null, fromBlock: null, toBlock: null, creations: 0, candidates: 0, registered: 0, belowFloor: 0, unpriced: 0, error: null, durationMs: 0 };
  const finish = (): BackfillReport => ({ ...r, durationMs: d.now() - t0 });
  if (d.spec.kind === 'v4' || d.spec.creationShape || !MULTICALL_CHAINS.includes(d.chain.id)) return finish_(r, 'skipped', 'unsupported', t0, d);
  try {
    if ((await d.store.disabledAdapters()).has(d.spec.id)) return finish_(r, 'skipped', 'disabled', t0, d);
    const key = backfillKey(d.spec.id, d.days);
    const head = await getHead(d.read);
    const safe = head - d.chain.confirmations;
    let cp = await d.store.getCheckpoint(key);
    if (cp?.blockHash === 'done') return finish_(r, 'done', null, t0, d);
    if (!cp) {
      const spb = await secondsPerBlock(d.read, head);
      const start = Math.max(0, safe - Math.round((d.days * 86_400) / spb));
      cp = { adapterId: key, block: start - 1, blockHash: 'walking', updatedAt: d.now() };
      await d.store.setCheckpoint(cp);
    }
    let from = cp.block + 1;
    r.fromBlock = from;
    const deadline = t0 + d.budgetMs;
    const floor = d.minLiquidityUsd ?? d.rules.minLiquidityUsd;
    const engine: EngineDeps = { spec: d.spec, chain: d.chain, read: d.read, store: d.store, rules: d.rules, now: d.now, launch: d.launch ?? null, nativeUsd: d.nativeUsd };
    const blank: RunReport = { adapterId: d.spec.id, ok: true, skipped: null, head, safeHead: safe, fromBlock: from, toBlock: null, lagBlocks: null, creations: 0, poolsNew: 0, tokensNew: 0, swapsSeen: 0, tradesNew: 0, skippedLogs: 0, reorg: null, error: null, durationMs: 0 };
    const tokenCache = new Map<string, TokenFacts | null>();
    const tokenFacts = async (a: string): Promise<TokenFacts | null> => {
      if (!tokenCache.has(a)) tokenCache.set(a, await readAnyToken(engine, a));
      return tokenCache.get(a) ?? null;
    };

    while (from <= safe && d.now() < deadline) {
      const to = Math.min(from + d.chain.maxRange - 1, safe);
      const logs = await getLogsHalving(d.read, { address: d.spec.factory, topics: [d.spec.creationTopic] }, from, to);
      const creations: Creation[] = [];
      for (const raw of logs) {
        const c = decodeCreation(raw, d.spec.kind, d.spec.factory);
        if (c && ADDRESS.test(c.pool) && c.block >= from && c.block <= to) creations.push(c);
      }
      r.creations += creations.length;
      // Only pairs with a recognised quote token, and not yet registered.
      const cands = creations.map((c) => ({ c, side: sideOf(d.chain, c.token0.toLowerCase(), c.token1.toLowerCase()) })).filter((x): x is { c: Creation; side: NonNullable<ReturnType<typeof sideOf>> } => x.side !== null);
      const known = cands.length ? await d.store.getPools(cands.map((x) => poolKeyOf(d.spec.chain, x.c.pool))) : new Map();
      const fresh = cands.filter((x) => !known.has(poolKeyOf(d.spec.chain, x.c.pool)));
      r.candidates += fresh.length;
      const size = Math.max(1, d.batch ?? 150);
      for (let i = 0; i < fresh.length; i += size) {
        const group = fresh.slice(i, i + size);
        const queries: ReserveQuery[] = group.map((x) => ({ kind: d.spec.kind as 'v2' | 'v3', pool: x.c.pool, base: x.side.base, quote: x.side.quote, baseIsToken0: x.side.baseIsToken0 }));
        const reserves = await readReservesBatch(d.read, queries);
        for (let k = 0; k < group.length; k++) {
          const { c, side } = group[k]!;
          const res = reserves[k];
          if (!res || res.base <= 0n || res.quote <= 0n) {
            r.belowFloor++;
            continue;
          }
          const quoteInfo = d.chain.quoteTokens.find((q) => q.address === side.quote)!;
          const usd = liquidityUsdOf(res.quote, quoteInfo.decimals, await quoteUsdFor(d.chain, side.quote, d.nativeUsd));
          if (usd === null) {
            r.unpriced++;
            continue;
          }
          if (usd < floor) {
            r.belowFloor++;
            continue;
          }
          const blk = await getBlock(d.read, c.block);
          if (!blk || blk.hash !== c.blockHash) throw new RpcError(`block ${c.block} changed while it was being read`, 'transport');
          const made = await registerPool(engine, c, blk.time * 1000, tokenFacts, blank);
          if (made) r.registered++;
        }
      }
      r.toBlock = to;
      await d.store.setCheckpoint({ adapterId: key, block: to, blockHash: 'walking', updatedAt: d.now() });
      from = to + 1;
    }
    if (from > safe) {
      await d.store.setCheckpoint({ adapterId: key, block: safe, blockHash: 'done', updatedAt: d.now() });
      r.state = 'done';
    }
  } catch (e) {
    r.ok = false;
    r.error = (e instanceof RpcError ? `${e.kind}: ${e.message}` : e instanceof Error ? e.message : 'the backfill failed').slice(0, 300);
  }
  return finish();
}

function finish_(r: BackfillReport, state: BackfillReport['state'], skipped: BackfillReport['skipped'], t0: number, d: BackfillDeps): BackfillReport {
  return { ...r, state, skipped, durationMs: d.now() - t0 };
}
