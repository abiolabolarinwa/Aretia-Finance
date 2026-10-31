/**
 * Adding one existing pool to the index on request, and reading its history further back over the following runs.
 *
 * The indexer finds pools as they are created, so a pool that already existed (or one it is not following) is unknown to it. When
 * someone opens such a pool, this reads it from the chain, checks that it belongs to a DEX Aretia indexes (a V2/V3 pool's `factory()`
 * must be a catalogued factory; a V4 pool id must have an `Initialize` event from a catalogued PoolManager), registers it and its
 * tokens, and reads its swaps backwards from the newest block for a window (default 24 hours). From then on it is followed like any
 * other pool, and `deepenHistory` extends its history a little each run until it reaches the pool's creation, or the retention
 * limit (the store keeps 30 days of trades, so reading further back would be thrown away).
 *
 * Creation time: V3 and V4 pools have an indexed creation event, so it is looked up and the pool gets its real age and a complete
 * history target. A V2 pair's creation event does not carry the pair address in a field a node can filter on, so a V2 pool keeps an
 * unknown creation time (createdAt 0, shown as no age, never guessed) and its history is read back as far as the retention limit.
 */
import { keccak256 } from '../core/keccak.js';
import type { MiChainConfig } from './chains.js';
import { decodeCreation, decodeSwap, tradeOf, type Creation } from './decode.js';
import { allSpecs, type DexAdapterSpec } from './dexes.js';
import { readAnyToken, refreshPool, registerPool, type EngineDeps, type RunReport } from './engine.js';
import { getBlock, getHead, getLogsHalving, readAddress, type TokenFacts } from './evmReads.js';
import { RpcError } from './rpc.js';
import { poolKeyOf, type MiPool, type MiTrade } from './types.js';

/** Blocks per hour by chain, for turning an hour window into a block range. */
const BLOCKS_PER_HOUR: Readonly<Record<string, number>> = { ethereum: 300, bnb: 4_800, polygon: 1_800, base: 1_800, robinhood: 14_400 };
const perHour = (chain: string): number => BLOCKS_PER_HOUR[chain] ?? 1_800;
export const DEFAULT_BACKFILL_HOURS = 24;
export const DEFAULT_RETENTION_DAYS = 30;

export type TrackResult =
  | { status: 'tracked'; key: string; trades: number; alreadyKnown: boolean; coveredHours: number; complete: boolean }
  | { status: 'unsupported'; reason: string }
  | { status: 'unreadable'; reason: string };

export interface TrackDeps extends Omit<EngineDeps, 'spec'> {
  /** One of the pool's tokens, from the page that asked: lets a hookless V4 pool be identified when the node will not search all history. */
  tokenHint?: string;
  backfillHours?: number;
  retentionDays?: number;
}

const EMPTY_REPORT = (id: string): RunReport => ({ adapterId: id, ok: true, skipped: null, head: null, safeHead: null, fromBlock: null, toBlock: null, lagBlocks: null, creations: 0, poolsNew: 0, tokensNew: 0, swapsSeen: 0, tradesNew: 0, skippedLogs: 0, reorg: null, error: null, durationMs: 0 });
const pad = (hex: string): string => '0x' + hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

/** Swaps of one pool in [from, to], decoded into trades. Blocks that changed while being read are skipped (the follower re-reads them). */
export async function readPoolSwaps(d: Pick<EngineDeps, 'read'>, spec: DexAdapterSpec, pool: MiPool, from: number, to: number, blocks: Map<number, { hash: string; time: number }>): Promise<MiTrade[]> {
  const filter = spec.kind === 'v4' ? { address: spec.factory, topics: [spec.swapTopic, pool.address] } : { address: pool.address, topics: [spec.swapTopic] };
  const logs = await getLogsHalving(d.read, filter, from, to);
  const trades: MiTrade[] = [];
  for (const raw of logs) {
    const s = decodeSwap(raw, spec.kind, spec.swapTopic);
    if (!s || s.pool !== pool.address || s.block < from || s.block > to) continue;
    let b = blocks.get(s.block);
    if (!b) {
      const got = await getBlock(d.read, s.block);
      if (!got) throw new RpcError(`block ${s.block} could not be read`, 'transport');
      b = { hash: got.hash, time: got.time };
      blocks.set(s.block, b);
    }
    if (b.hash !== s.blockHash) continue;
    const t = tradeOf(pool, s, b.time);
    if (t) trades.push(t);
  }
  return trades;
}

const word = (n: bigint | string): string => (typeof n === 'bigint' ? n.toString(16) : n.replace(/^0x/, '')).padStart(64, '0');
const hexOf = (b: Uint8Array): string => '0x' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** A V4 pool's id: keccak256 of its key (currency0, currency1, fee, tickSpacing, hooks) ABI-encoded as five words. */
export function v4PoolId(key: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }): string {
  const hex = word(key.currency0) + word(key.currency1) + word(BigInt(key.fee)) + word(BigInt.asUintN(256, BigInt(key.tickSpacing))) + word(key.hooks);
  return hexOf(keccak256(Uint8Array.from(hex.match(/../g)!.map((b) => Number.parseInt(b, 16)))));
}

/** The standard hookless fee tiers and their tick spacings. */
const V4_TIERS: readonly [number, number][] = [[100, 1], [500, 10], [2500, 50], [3000, 60], [10_000, 200]];

/**
 * Finds the key of a hookless V4 pool from one of its tokens by trying the chain's quote tokens and the standard fee tiers against the
 * pool id. The match is the proof: the id is a hash of the key, so a key that hashes to it IS the pool's key. Used only when the node
 * will not search the PoolManager's whole history for the Initialize event. Hooked pools and non-standard tiers cannot be found this way.
 */
export function v4KeyFromToken(id: string, token: string, quotes: readonly string[]): { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string } | null {
  const hooks = '0x' + '0'.repeat(40);
  for (const q of quotes) {
    if (q === token) continue;
    const [currency0, currency1] = q < token ? [q, token] : [token, q];
    for (const [fee, tickSpacing] of V4_TIERS) if (v4PoolId({ currency0, currency1, fee, tickSpacing, hooks }) === id) return { currency0, currency1, fee, tickSpacing, hooks };
  }
  return null;
}

async function creationOf(d: Pick<EngineDeps, 'read'>, spec: DexAdapterSpec, head: number, filterTopics: string[]): Promise<{ log: unknown; block: number; time: number } | null> {
  const logs = await getLogsHalving(d.read, { address: spec.factory, topics: filterTopics }, 0, head);
  const log = logs[0];
  if (log === undefined) return null;
  const c = decodeCreation(log, spec.kind, spec.factory);
  if (!c) return null;
  const b = await getBlock(d.read, c.block);
  return b ? { log, block: c.block, time: b.time } : null;
}

export async function trackEvmPool(d: TrackDeps, chain: MiChainConfig, address: string): Promise<TrackResult> {
  const id = address.toLowerCase();
  const isId = /^0x[0-9a-f]{64}$/.test(id);
  if (!isId && !/^0x[0-9a-f]{40}$/.test(id)) return { status: 'unsupported', reason: 'not an address or pool id' };
  const key = poolKeyOf(chain.id, id);
  const known = (await d.store.getPools([key])).get(key);
  if (known) return { status: 'tracked', key, trades: 0, alreadyKnown: true, coveredHours: 0, complete: known.historyDone };

  const head = await getHead(d.read);
  const safe = head - chain.confirmations;
  let spec: DexAdapterSpec | undefined;
  let creation: Creation;
  let createdAtMs = 0;

  if (isId) {
    // A V4 pool is its id: the PoolManager's Initialize event for it gives the pool key and the creation block.
    spec = allSpecs().find((s) => s.chain === chain.id && s.kind === 'v4');
    if (!spec) return { status: 'unsupported', reason: 'Uniswap V4 is not indexed on this network' };
    let found: Awaited<ReturnType<typeof creationOf>> = null;
    let searched = true;
    try {
      found = await creationOf(d, spec, safe, [spec.creationTopic, id]);
    } catch (e) {
      // A public node refuses a search of the whole history ("archive requests", "range too large"): fall back to proving the key by hash.
      if (!(e instanceof RpcError)) throw e;
      searched = false;
    }
    if (found) {
      creation = { ...decodeCreation(found.log, 'v4', spec.factory)!, tx: 'tracked' };
      createdAtMs = found.time * 1000;
    } else {
      const hint = d.tokenHint?.toLowerCase();
      const key = hint && /^0x[0-9a-f]{40}$/.test(hint) ? v4KeyFromToken(id, hint, chain.quoteTokens.map((q) => q.address)) : null;
      if (!key) return searched ? { status: 'unsupported', reason: 'no such pool in the V4 PoolManager' } : { status: 'unreadable', reason: "this network's node would not search the pool's history, and its key is not a standard hookless one" };
      creation = { token0: key.currency0, token1: key.currency1, pool: id, feeTier: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks, block: 0, blockHash: '', tx: 'tracked', logIndex: 0 };
    }
  } else {
    const factory = await readAddress(d.read, id, '0xc45a0155');
    spec = factory ? allSpecs().find((s) => s.chain === chain.id && s.factory === factory && s.kind !== 'v4') : undefined;
    if (!spec) return { status: 'unsupported', reason: 'not a pool of a DEX Aretia indexes on this network' };
    const [t0, t1] = [await readAddress(d.read, id, '0x0dfe1681'), await readAddress(d.read, id, '0xd21220a7')];
    if (!t0 || !t1) return { status: 'unreadable', reason: 'the pool did not answer token0 and token1' };
    creation = { token0: t0, token1: t1, pool: id, feeTier: null, block: 0, blockHash: '', tx: 'tracked', logIndex: 0 };
    if (spec.kind === 'v3' && !spec.creationShape) {
      const fee = Number.parseInt((await d.read('eth_call', [{ to: id, data: '0xddca3f43' }, 'latest'])) as string, 16);
      const feeTier = Number.isInteger(fee) ? fee : null;
      creation.feeTier = feeTier;
      // PoolCreated indexes both tokens and the fee, so this pool's creation can be found exactly.
      if (feeTier !== null) {
        const found = await creationOf(d, spec, safe, [spec.creationTopic, pad(t0), pad(t1), pad(feeTier.toString(16))]);
        const c = found ? decodeCreation(found.log, 'v3', spec.factory) : null;
        if (found && c && c.pool === id) {
          creation = { ...creation, block: c.block, blockHash: c.blockHash };
          createdAtMs = found.time * 1000;
        }
      }
    }
  }

  const deps: EngineDeps = { ...d, spec, chain };
  const cache = new Map<string, TokenFacts | null>();
  const tokenFacts = async (a: string): Promise<TokenFacts | null> => {
    if (!cache.has(a)) cache.set(a, await readAnyToken(d, a));
    return cache.get(a) ?? null;
  };
  await registerPool(deps, { ...creation, tracked: true }, createdAtMs, tokenFacts, EMPTY_REPORT(spec.id));
  const stored = (await d.store.getPools([key])).get(key) ?? null;
  if (!stored) return { status: 'unreadable', reason: 'the pool could not be registered' };
  if (stored.state === 'unsupported') return { status: 'unsupported', reason: stored.stateReason };

  // Swaps, newest block range first, so the most recent trading is there even if the budget ends early.
  const hours = d.backfillHours ?? DEFAULT_BACKFILL_HOURS;
  const floor = Math.max(stored.createdBlock, safe - hours * perHour(chain.id));
  const deadline = d.now() + (d.budgetMs ?? 25_000);
  const blocks = new Map<number, { hash: string; time: number }>();
  const trades: MiTrade[] = [];
  let to = safe;
  let reached = safe + 1;
  while (to >= floor && d.now() < deadline) {
    const from = Math.max(floor, to - chain.maxRange + 1);
    trades.push(...(await readPoolSwaps(d, spec, stored, from, to, blocks)));
    reached = from;
    to = from - 1;
  }
  await d.store.putTrades(spec.id, trades);
  const complete = stored.createdBlock > 0 && reached <= stored.createdBlock;
  await d.store.updatePool(key, { historyBlock: reached, historyDone: complete });
  await refreshPool(deps, { ...stored, historyBlock: reached, historyDone: complete }, trades, tokenFacts);
  return { status: 'tracked', key, trades: trades.length, alreadyKnown: false, coveredHours: Math.round(((safe - reached) / perHour(chain.id)) * 10) / 10, complete };
}

/**
 * Reads a few pools' swaps further back, a bounded amount per run. Each pool moves its `historyBlock` back until it reaches its creation
 * (when known) or the retention limit, and is then marked complete. Safe to repeat: trades are stored idempotently.
 */
export async function deepenHistory(d: EngineDeps & { retentionDays?: number }, opts: { pools?: number; chunksPerPool?: number; budgetMs?: number } = {}): Promise<{ pools: number; trades: number; completed: number }> {
  const pools = await d.store.poolsNeedingHistory(d.spec.id, opts.pools ?? 3);
  if (pools.length === 0) return { pools: 0, trades: 0, completed: 0 };
  const head = await getHead(d.read);
  const safe = head - d.chain.confirmations;
  const retentionBlocks = (d.retentionDays ?? DEFAULT_RETENTION_DAYS) * 24 * perHour(d.chain.id);
  const deadline = d.now() + (opts.budgetMs ?? 15_000);
  const blocks = new Map<number, { hash: string; time: number }>();
  let tradeCount = 0;
  let completed = 0;
  for (const pool of pools) {
    if (d.now() >= deadline) break;
    const target = Math.max(pool.createdBlock, safe - retentionBlocks);
    let at = pool.historyBlock ?? safe;
    const trades: MiTrade[] = [];
    for (let i = 0; i < (opts.chunksPerPool ?? 6) && at > target && d.now() < deadline; i++) {
      const to = at - 1;
      const from = Math.max(target, to - d.chain.maxRange + 1);
      trades.push(...(await readPoolSwaps(d, d.spec, pool, from, to, blocks)));
      at = from;
    }
    await d.store.putTrades(d.spec.id, trades);
    tradeCount += trades.length;
    const done = at <= target;
    if (done) completed++;
    await d.store.updatePool(pool.key, { historyBlock: at, historyDone: done });
  }
  return { pools: pools.length, trades: tradeCount, completed };
}
