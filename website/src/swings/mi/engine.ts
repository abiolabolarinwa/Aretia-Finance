/**
 * The EVM indexing engine: one adapter (one factory on one chain) per run.
 *
 * Guarantees, each covered by a test in engine.test.ts:
 *  - Checkpoint: the per-adapter cursor moves only after every write of the range succeeded. A crash in between re-reads the
 *    range; all writes are idempotent, so nothing is lost and nothing is duplicated.
 *  - Finality: only blocks `confirmations` deep are read. On top of that each run compares the stored hash of the checkpoint
 *    block with the node's; a mismatch is a reorg: the indexer walks back to the fork, deletes what it wrote above it, and
 *    re-reads. A log whose block hash differs from the block it is timed against aborts the chunk.
 *  - Backfill / recovery: a run continues from the checkpoint however long the downtime was, chunk by chunk, within a time budget.
 *    An explicit range can be re-processed (an admin backfill job) without moving the checkpoint.
 *  - Ordering: logs are processed sorted by (block, logIndex); candles and stats do not depend on arrival order.
 *  - Failure: a transport failure throws out of the chunk; the cursor stays; the failure is recorded in health.
 */
import type { MiChainConfig } from './chains.js';
import { decodeCreation, decodeSwap, logMeta, tradeOf, type Creation } from './decode.js';
import type { DexAdapterSpec } from './dexes.js';
import { getBlock, getHead, getLogsHalving, readBalance, readToken, readV2Reserves, type BlockInfo, type TokenFacts } from './evmReads.js';
import { evaluate, FOLLOWED_STATES, type ListingRules, type PoolFacts } from './lifecycle.js';
import { parseRaw } from './math.js';
import { RpcError, type Read } from './rpc.js';
import { computeStats, type UsdContext } from './stats.js';
import type { MiStore } from './store.js';
import { poolKeyOf, tokenKeyOf, type MiPool, type MiToken, type MiTrade } from './types.js';

/** Looks up which of these token addresses Aretia Launch Box already holds. Read-only. */
export interface LaunchLookup {
  find(chain: string, addresses: readonly string[]): Promise<Map<string, string>>;
}

export interface EngineDeps {
  spec: DexAdapterSpec;
  chain: MiChainConfig;
  read: Read;
  store: MiStore;
  rules: ListingRules;
  now: () => number;
  launch?: LaunchLookup | null;
  /** What one whole quote token is worth in dollars, by token address; role-based fallback is applied inside. */
  nativeUsd?: () => Promise<number | null>;
  /** Wall-clock budget for one run, ms. */
  budgetMs?: number;
  /** How many pools' swaps are followed per run (newest created plus most recently traded). */
  followNewest?: number;
  maintainWaiting?: number;
  maintainLive?: number;
  followRecent?: number;
}

export interface RunReport {
  adapterId: string;
  ok: boolean;
  skipped: 'disabled' | 'up-to-date' | null;
  head: number | null;
  safeHead: number | null;
  fromBlock: number | null;
  toBlock: number | null;
  lagBlocks: number | null;
  creations: number;
  poolsNew: number;
  tokensNew: number;
  swapsSeen: number;
  tradesNew: number;
  skippedLogs: number;
  /** Blocks skipped because the adapter was further behind than the chain's allowed lag (see MiChainConfig.maxLagBlocks). */
  skippedBlocks?: number;
  maintained?: number;
  reorg: { forkBlock: number; poolsDeleted: number; tradesDeleted: number } | null;
  error: string | null;
  durationMs: number;
}

const ZERO = /^0x0{40}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

class ChunkAbort extends Error {}

export async function runAdapter(d: EngineDeps, opts: { range?: { from: number; to: number }; onProgress?: (doneBlock: number) => Promise<void> } = {}): Promise<RunReport> {
  const t0 = d.now();
  const report: RunReport = { adapterId: d.spec.id, ok: true, skipped: null, head: null, safeHead: null, fromBlock: null, toBlock: null, lagBlocks: null, creations: 0, poolsNew: 0, tokensNew: 0, swapsSeen: 0, tradesNew: 0, skippedLogs: 0, reorg: null, error: null, durationMs: 0 };
  const finish = async (): Promise<RunReport> => {
    report.durationMs = d.now() - t0;
    await recordHealth(d, report).catch(() => undefined);
    return report;
  };
  if ((await d.store.disabledAdapters()).has(d.spec.id)) {
    report.skipped = 'disabled';
    return finish();
  }
  try {
    const head = await getHead(d.read);
    const safe = head - d.chain.confirmations;
    report.head = head;
    report.safeHead = safe;

    let cursor: number | null = null;
    if (!opts.range) {
      let cp = await d.store.getCheckpoint(d.spec.id);
      if (cp) {
        const onChain = await getBlock(d.read, cp.block);
        if (!onChain) throw new RpcError('the checkpoint block could not be read', 'transport');
        if (onChain.hash !== cp.blockHash) {
          report.reorg = await rewind(d, cp.block);
          cp = await d.store.getCheckpoint(d.spec.id);
        }
      }
      cursor = cp ? cp.block : null;
    }

    let from = opts.range ? opts.range.from : cursor !== null ? cursor + 1 : Math.max(0, safe - d.chain.lookback);
    // Too far behind (a slow node, or days of downtime): read the recent past instead of chasing the whole gap, which on a free node can
    // take longer than the chain adds blocks. The skipped range is reported, and an admin backfill can read it later.
    if (!opts.range && cursor !== null && d.chain.maxLagBlocks > 0 && safe - cursor > d.chain.maxLagBlocks) {
      const jump = safe - d.chain.maxLagBlocks;
      report.skippedBlocks = Math.max(0, jump - from);
      from = Math.max(from, jump);
    }
    const limit = opts.range ? Math.min(opts.range.to, safe) : safe;
    report.fromBlock = from;
    const deadline = t0 + (d.budgetMs ?? 40_000);
    const follow = await followedPools(d);

    while (from <= limit && d.now() < deadline) {
      const to = Math.min(from + d.chain.maxRange - 1, limit);
      const chunk = await processChunk(d, from, to, follow, report);
      report.toBlock = to;
      if (!opts.range) {
        // Last: only now does the cursor move. Everything above was written idempotently.
        await d.store.putBlockHash(d.spec.id, to, chunk.hash);
        await d.store.setCheckpoint({ adapterId: d.spec.id, block: to, blockHash: chunk.hash, updatedAt: d.now() });
        await d.store.pruneBlockHashes(d.spec.id, to - 5_000);
      }
      if (opts.onProgress) await opts.onProgress(to);
      from = to + 1;
    }
    // A pool can be funded, drained or go quiet without a swap to tell us: re-read the newest waiting pools and the busiest live ones.
    if (!opts.range) await maintain(d, report);
    if (report.toBlock === null) report.skipped = 'up-to-date';
    const reached = report.toBlock ?? (from - 1);
    report.lagBlocks = Math.max(0, head - reached);
  } catch (e) {
    report.ok = false;
    report.error = (e instanceof Error ? e.message : 'the run failed').slice(0, 300);
  }
  return finish();
}

// ---------------------------------------------------------------------------------------------- chunk

interface Follow {
  pools: Map<string, MiPool>;
}

async function followedPools(d: EngineDeps): Promise<Follow> {
  const newest = await d.store.poolsOfAdapter(d.spec.id, FOLLOWED_STATES, d.followNewest ?? 100, 'newest');
  const recent = await d.store.poolsOfAdapter(d.spec.id, FOLLOWED_STATES, d.followRecent ?? 100, 'recent-trade');
  const pools = new Map<string, MiPool>();
  for (const p of [...newest, ...recent]) pools.set(p.address, p);
  return { pools };
}

async function processChunk(d: EngineDeps, from: number, to: number, follow: Follow, report: RunReport): Promise<{ hash: string }> {
  const blocks = new Map<number, BlockInfo>();
  const blockAt = async (n: number): Promise<BlockInfo> => {
    const hit = blocks.get(n);
    if (hit) return hit;
    const b = await getBlock(d.read, n);
    if (!b) throw new RpcError(`block ${n} could not be read`, 'transport');
    blocks.set(n, b);
    return b;
  };
  const tokenCache = new Map<string, TokenFacts | null>();
  const tokenFacts = async (address: string): Promise<TokenFacts | null> => {
    if (tokenCache.has(address)) return tokenCache.get(address) ?? null;
    const f = await readToken(d.read, address);
    tokenCache.set(address, f);
    return f;
  };

  // ---- creations
  const rawCreations = await getLogsHalving(d.read, { address: d.spec.factory, topics: [d.spec.creationTopic] }, from, to);
  const creations: Creation[] = [];
  for (const raw of rawCreations) {
    const c = decodeCreation(raw, d.spec.kind, d.spec.factory);
    if (c && c.block >= from && c.block <= to && ADDRESS.test(c.pool) && !ZERO.test(c.pool)) creations.push(c);
    else report.skippedLogs++;
  }
  creations.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  report.creations += creations.length;
  const touched = new Set<string>();
  for (const c of creations) {
    const b = await blockAt(c.block);
    if (b.hash !== c.blockHash) throw new ChunkAbort(`block ${c.block} changed while it was being read`);
    const created = await registerPool(d, c, b.time * 1000, tokenFacts, report);
    if (created) follow.pools.set(created.address, created);
    touched.add(c.pool);
  }

  // ---- swaps of followed pools
  const poolList = [...follow.pools.values()].filter((p) => p.createdBlock <= to);
  const batch = Math.max(1, d.chain.addressBatch);
  const groups: MiPool[][] = [];
  for (let i = 0; i < poolList.length; i += batch) groups.push(poolList.slice(i, i + batch));
  const fetched: { group: MiPool[]; logs: unknown[] }[] = [];
  // A few getLogs calls at once: the reader limits concurrency per node, this only keeps it busy.
  for (let i = 0; i < groups.length; i += 4) {
    fetched.push(...(await Promise.all(groups.slice(i, i + 4).map(async (group) => ({ group, logs: await getLogsHalving(d.read, { address: group.map((p) => p.address), topics: [d.spec.swapTopic] }, from, to) })))));
  }
  const trades: MiTrade[] = [];
  for (const { group, logs } of fetched) {
    const byAddr = new Map(group.map((p) => [p.address, p]));
    const decoded = [];
    for (const raw of logs) {
      const s = decodeSwap(raw, d.spec.kind, d.spec.swapTopic);
      if (s && byAddr.has(s.pool) && s.block >= from && s.block <= to) decoded.push(s);
      else report.skippedLogs++;
    }
    decoded.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    for (const s of decoded) {
      const b = await blockAt(s.block);
      if (b.hash !== s.blockHash) throw new ChunkAbort(`block ${s.block} changed while it was being read`);
      const t = tradeOf(byAddr.get(s.pool)!, s, b.time);
      report.swapsSeen++;
      if (t) trades.push(t);
    }
  }
  report.tradesNew += await d.store.putTrades(d.spec.id, trades);

  // ---- derived pool state, only for pools that moved in this chunk
  const traded = new Map<string, MiTrade[]>();
  for (const t of trades) (traded.get(t.pool) ?? traded.set(t.pool, []).get(t.pool)!).push(t);
  for (const address of new Set([...touched, ...traded.keys()])) {
    const pool = follow.pools.get(address);
    if (pool) await refreshPool(d, pool, traded.get(address) ?? [], tokenFacts);
  }

  const tip = await blockAt(to);
  return { hash: tip.hash };
}

export async function registerPool(d: EngineDeps, c: Creation, createdAtMs: number, tokenFacts: (a: string) => Promise<TokenFacts | null>, report: RunReport): Promise<MiPool | null> {
  const key = poolKeyOf(d.spec.chain, c.pool);
  if ((await d.store.getPools([key])).has(key)) return null; // idempotent: a pool is registered once
  const t0 = c.token0.toLowerCase();
  const t1 = c.token1.toLowerCase();
  if (!ADDRESS.test(t0) || !ADDRESS.test(t1) || t0 === t1 || ZERO.test(t0) || ZERO.test(t1)) return null;

  const quotes = d.chain.quoteTokens;
  const q0 = quotes.find((q) => q.address === t0);
  const q1 = quotes.find((q) => q.address === t1);
  // The quote side is the recognised token; with two, a dollar stablecoin wins over the wrapped native coin.
  let quoteIsToken1: boolean;
  if (q0 && q1) quoteIsToken1 = q1.role === 'usd' || q0.role !== 'usd';
  else quoteIsToken1 = !q0;
  const baseAddr = quoteIsToken1 ? t0 : t1;
  const quoteAddr = quoteIsToken1 ? t1 : t0;
  const quoteRecognised = Boolean(q0 || q1);

  const [bf, qf] = await Promise.all([tokenFacts(baseAddr), tokenFacts(quoteAddr)]);
  const readable = bf !== null && qf !== null;
  const now = d.now();
  const pool: MiPool = {
    key,
    chain: d.spec.chain,
    address: c.pool,
    adapterId: d.spec.id,
    dex: d.spec.family,
    kind: d.spec.kind,
    feeTier: c.feeTier,
    base: baseAddr,
    quote: quoteAddr,
    baseDecimals: bf?.decimals ?? 0,
    quoteDecimals: qf?.decimals ?? 0,
    baseIsToken0: baseAddr === t0,
    baseVault: null,
    quoteVault: null,
    createdBlock: c.block,
    createdTx: c.tx,
    createdAt: createdAtMs,
    state: 'discovered',
    stateReason: 'creation event seen',
    stateAt: now,
    reserveBase: null,
    reserveQuote: null,
    reserveBlock: null,
    firstTradeAt: null,
    lastTradeAt: null,
    paused: false,
    stats: null,
  };
  if (readable) {
    for (const [addr, f] of [[baseAddr, bf], [quoteAddr, qf]] as const) {
      const token: MiToken = { key: tokenKeyOf(d.spec.chain, addr), chain: d.spec.chain, address: addr, symbol: f.symbol, name: f.name, decimals: f.decimals, firstSeenAt: now, firstTradeAt: null, launchboxKey: null };
      if (await d.store.upsertToken(token)) report.tokensNew++;
    }
    if (d.launch) {
      const found = await d.launch.find(d.spec.chain, [baseAddr, quoteAddr]);
      for (const [addr, lbKey] of found) await d.store.setTokenLaunchbox(tokenKeyOf(d.spec.chain, addr), lbKey);
    }
  }
  const facts = await poolFacts(d, pool, readable, quoteRecognised);
  Object.assign(pool, applyReserves(pool, facts));
  const ev = evaluate('discovered', facts.facts, d.rules, now);
  pool.state = ev.state;
  pool.stateReason = ev.reason;
  if (await d.store.insertPool(pool)) report.poolsNew++;
  return pool;
}

interface ReadFacts {
  facts: PoolFacts;
  reserves: { base: bigint; quote: bigint } | null;
}

function applyReserves(pool: MiPool, f: ReadFacts): Partial<MiPool> {
  return f.reserves ? { reserveBase: f.reserves.base.toString(), reserveQuote: f.reserves.quote.toString() } : { reserveBase: pool.reserveBase, reserveQuote: pool.reserveQuote };
}

async function poolFacts(d: EngineDeps, pool: MiPool, tokensReadable: boolean | null, quoteRecognised: boolean): Promise<ReadFacts> {
  let reserves: { base: bigint; quote: bigint } | null = null;
  if (tokensReadable && quoteRecognised) {
    if (pool.kind === 'v2') {
      const r = await readV2Reserves(d.read, pool.address);
      if (r) reserves = pool.baseIsToken0 ? { base: r[0], quote: r[1] } : { base: r[1], quote: r[0] };
    } else {
      // A V3 pool has no reserves call: the liquidity it can serve is bounded by the tokens it holds.
      const [b, q] = [await readBalance(d.read, pool.base, pool.address), await readBalance(d.read, pool.quote, pool.address)];
      if (b !== null && q !== null) reserves = { base: b, quote: q };
    }
  }
  const quoteUsd = await quoteUsdOf(d, pool);
  const liquidityUsd = reserves && quoteUsd !== null ? (Number(reserves.quote) / 10 ** pool.quoteDecimals) * 2 * quoteUsd : null;
  return {
    reserves,
    facts: {
      tokensReadable,
      quoteRecognised,
      reserveBase: reserves ? reserves.base : null,
      reserveQuote: reserves ? reserves.quote : null,
      liquidityUsd,
      createdAt: pool.createdAt,
      firstSeenAt: pool.stateAt,
      lastTradeAt: pool.lastTradeAt,
      paused: pool.paused,
    },
  };
}

/** Dollar value of one whole quote token: 1 for a dollar stablecoin, the chain's reference price for the native coin, otherwise unknown. */
async function quoteUsdOf(d: EngineDeps, pool: MiPool): Promise<number | null> {
  const q = d.chain.quoteTokens.find((x) => x.address === pool.quote);
  if (!q) return null;
  if (q.role === 'usd') return 1;
  return d.nativeUsd ? await d.nativeUsd() : null;
}

export async function refreshPool(d: EngineDeps, pool: MiPool, newTrades: MiTrade[], tokenFacts: (a: string) => Promise<TokenFacts | null>): Promise<void> {
  const now = d.now();
  const quoteRecognised = d.chain.quoteTokens.some((q) => q.address === pool.base || q.address === pool.quote);
  const stored = (await d.store.getPools([pool.key])).get(pool.key) ?? pool;
  let first = stored.firstTradeAt;
  let last = stored.lastTradeAt;
  for (const t of newTrades) {
    const ms = t.time * 1000;
    first = first === null ? ms : Math.min(first, ms);
    last = last === null ? ms : Math.max(last, ms);
  }
  const live: MiPool = { ...stored, firstTradeAt: first, lastTradeAt: last };
  const readable = (await tokenFacts(live.base)) !== null && (await tokenFacts(live.quote)) !== null;
  const rf = await poolFacts(d, live, readable, quoteRecognised);
  const ev = evaluate(live.state, { ...rf.facts, firstSeenAt: live.stateAt }, d.rules, now);

  const nowSec = Math.floor(now / 1000);
  const since = nowSec - 86_400;
  const recent = await d.store.tradesSince(live.chain, live.address, since, 5_000);
  const prior = await d.store.lastTradeBefore(live.chain, live.address, since);
  const quoteUsd = await quoteUsdOf(d, live);
  const usd: UsdContext = { quoteUsd };
  const stats = computeStats(live, recent, prior, now, usd, rf.reserves ? rf.reserves.quote : parseRaw(live.reserveQuote));

  const patch: Partial<MiPool> = { firstTradeAt: first, lastTradeAt: last, stats, ...applyReserves(live, rf) };
  if (rf.reserves) patch.reserveBlock = null;
  if (ev.state !== stored.state) {
    patch.state = ev.state;
    patch.stateReason = ev.reason;
    patch.stateAt = now;
  }
  await d.store.updatePool(live.key, patch);
  if (first !== null) await d.store.setTokenFirstTrade(tokenKeyOf(live.chain, live.base), first);
}

/** Re-evaluates pools whose state can change without a swap. Bounded: a handful of reads per run. */
async function maintain(d: EngineDeps, report: RunReport): Promise<void> {
  const waiting = await d.store.poolsOfAdapter(d.spec.id, ['validating', 'awaiting_liquidity'], d.maintainWaiting ?? 30, 'newest');
  const live = await d.store.poolsOfAdapter(d.spec.id, ['active', 'inactive'], d.maintainLive ?? 30, 'recent-trade');
  const tokenCache = new Map<string, TokenFacts | null>();
  const tokenFacts = async (a: string): Promise<TokenFacts | null> => {
    if (!tokenCache.has(a)) tokenCache.set(a, await readToken(d.read, a));
    return tokenCache.get(a) ?? null;
  };
  for (const p of [...waiting, ...live]) {
    await refreshPool(d, p, [], tokenFacts);
    report.maintained = (report.maintained ?? 0) + 1;
  }
}

// ---------------------------------------------------------------------------------------------- reorg

/**
 * The checkpoint block's hash no longer matches the chain: walk back through stored block hashes to the last one that still
 * matches (the fork point), delete what was written above it, and move the checkpoint there so the next chunk re-reads.
 */
export async function rewind(d: EngineDeps, from: number): Promise<{ forkBlock: number; poolsDeleted: number; tradesDeleted: number }> {
  let probe = from - 1;
  let fork: { block: number; hash: string } | null = null;
  for (let i = 0; i < 64; i++) {
    const stored = await d.store.blockHashAtOrBelow(d.spec.id, probe);
    if (!stored) break;
    const onChain = await getBlock(d.read, stored.block);
    if (onChain && onChain.hash === stored.hash) {
      fork = stored;
      break;
    }
    probe = stored.block - 1;
  }
  // No stored hash still matches: fall back to a deep, safe rewind from the checkpoint.
  const forkBlock = fork ? fork.block : Math.max(0, from - 1_000);
  const tradesDeleted = await d.store.deleteTradesFrom(d.spec.id, forkBlock + 1);
  const poolsDeleted = await d.store.deletePoolsCreatedFrom(d.spec.id, forkBlock + 1);
  const tip = fork ? fork.hash : ((await getBlock(d.read, forkBlock))?.hash ?? '');
  if (tip) await d.store.setCheckpoint({ adapterId: d.spec.id, block: forkBlock, blockHash: tip, updatedAt: d.now() });
  return { forkBlock, poolsDeleted, tradesDeleted };
}

// ---------------------------------------------------------------------------------------------- health

async function recordHealth(d: EngineDeps, r: RunReport): Promise<void> {
  const prev = (await d.store.listHealth()).find((h) => h.adapterId === d.spec.id);
  const cp = await d.store.getCheckpoint(d.spec.id);
  const now = d.now();
  await d.store.putHealth({
    adapterId: d.spec.id,
    chain: d.spec.chain,
    head: r.head,
    safeHead: r.safeHead,
    checkpoint: cp?.block ?? null,
    lagBlocks: r.safeHead !== null && cp ? Math.max(0, r.safeHead - cp.block) : null,
    lastRunAt: now,
    lastSuccessAt: r.ok ? now : (prev?.lastSuccessAt ?? null),
    lastError: r.ok ? null : r.error,
    consecutiveFailures: r.ok ? 0 : (prev?.consecutiveFailures ?? 0) + 1,
    stats: { creations: r.creations, poolsNew: r.poolsNew, tokensNew: r.tokensNew, swapsSeen: r.swapsSeen, tradesNew: r.tradesNew, skippedLogs: r.skippedLogs, durationMs: r.durationMs, reorgs: r.reorg ? 1 : 0 },
  });
}

export { logMeta };
