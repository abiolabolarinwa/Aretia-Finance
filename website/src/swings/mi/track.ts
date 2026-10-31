/**
 * Adding one existing pool to the index on request. The indexer finds pools as they are created, so a pool that already existed
 * (or one it is not following) is unknown to it. When someone opens such a pool, this reads it from the chain, checks that it is a
 * pool of a DEX Aretia indexes (its `factory()` must be a catalogued factory, so a request cannot make the server read an
 * arbitrary contract's logs), registers it and its tokens, and reads its recent swaps backwards from the newest block until the
 * budget or the backfill window ends. From then on it is followed like any other pool.
 *
 * What it cannot know is when the pool was created: that is stored as unknown (createdAt 0) and shown as no age, never guessed.
 * History starts at the oldest block read, so a tracked pool's chart is as deep as that window, not as deep as the pool's life.
 */
import type { MiChainConfig } from './chains.js';
import { decodeSwap, tradeOf, type Creation } from './decode.js';
import { allSpecs, type DexAdapterSpec } from './dexes.js';
import { refreshPool, registerPool, type EngineDeps, type RunReport } from './engine.js';
import { getBlock, getHead, getLogsHalving, readAddress, readToken, type TokenFacts } from './evmReads.js';
import { RpcError } from './rpc.js';
import { poolKeyOf, type MiPool, type MiTrade } from './types.js';

/** Hours of swings read back for a tracked pool, by block time (blocks per hour). */
const BLOCKS_PER_HOUR: Readonly<Record<string, number>> = { ethereum: 300, bnb: 4_800, polygon: 1_800, base: 1_800, arbitrum: 14_400, optimism: 1_800, avalanche: 1_800 };
export const DEFAULT_BACKFILL_HOURS = 6;

export type TrackResult =
  | { status: 'tracked'; key: string; trades: number; alreadyKnown: boolean; coveredHours: number }
  | { status: 'unsupported'; reason: string }
  | { status: 'unreadable'; reason: string };

export interface TrackDeps extends Omit<EngineDeps, 'spec'> {
  backfillHours?: number;
}

const EMPTY_REPORT = (id: string): RunReport => ({ adapterId: id, ok: true, skipped: null, head: null, safeHead: null, fromBlock: null, toBlock: null, lagBlocks: null, creations: 0, poolsNew: 0, tokensNew: 0, swapsSeen: 0, tradesNew: 0, skippedLogs: 0, reorg: null, error: null, durationMs: 0 });

export async function trackEvmPool(d: TrackDeps, chain: MiChainConfig, address: string): Promise<TrackResult> {
  const pool = address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(pool)) return { status: 'unsupported', reason: 'not an address' };
  const key = poolKeyOf(chain.id, pool);
  const known = (await d.store.getPools([key])).get(key);
  if (known) return { status: 'tracked', key, trades: 0, alreadyKnown: true, coveredHours: 0 };

  // A pool of a catalogued DEX names its factory; anything else is refused before any log is read.
  const factory = await readAddress(d.read, pool, '0xc45a0155');
  const spec: DexAdapterSpec | undefined = factory ? allSpecs().find((s) => s.chain === chain.id && s.factory === factory) : undefined;
  if (!spec) return { status: 'unsupported', reason: 'not a pool of a DEX Aretia indexes on this network' };
  const [t0, t1] = [await readAddress(d.read, pool, '0x0dfe1681'), await readAddress(d.read, pool, '0xd21220a7')];
  if (!t0 || !t1) return { status: 'unreadable', reason: 'the pool did not answer token0 and token1' };
  let feeTier: number | null = null;
  if (spec.kind === 'v3') {
    const fee = Number.parseInt((await d.read('eth_call', [{ to: pool, data: '0xddca3f43' }, 'latest'])) as string, 16);
    feeTier = Number.isInteger(fee) ? fee : null;
  }
  const deps: EngineDeps = { ...d, spec, chain };
  const cache = new Map<string, TokenFacts | null>();
  const tokenFacts = async (a: string): Promise<TokenFacts | null> => {
    if (!cache.has(a)) cache.set(a, await readToken(d.read, a));
    return cache.get(a) ?? null;
  };
  const creation: Creation = { token0: t0, token1: t1, pool, feeTier, block: 0, blockHash: '', tx: 'tracked', logIndex: 0 };
  const registered = await registerPool(deps, creation, 0, tokenFacts, EMPTY_REPORT(spec.id));
  const stored = registered ?? (await d.store.getPools([key])).get(key) ?? null;
  if (!stored) return { status: 'unreadable', reason: 'the pool could not be registered' };
  if (stored.state === 'unsupported') return { status: 'unsupported', reason: stored.stateReason };

  // Swaps, newest block range first, so the most recent trading is there even if the budget ends early.
  const head = await getHead(d.read);
  const safe = head - chain.confirmations;
  const hours = d.backfillHours ?? DEFAULT_BACKFILL_HOURS;
  const floor = Math.max(0, safe - hours * (BLOCKS_PER_HOUR[chain.id] ?? 1_800));
  const deadline = d.now() + (d.budgetMs ?? 25_000);
  const blocks = new Map<number, { hash: string; time: number }>();
  const trades: MiTrade[] = [];
  let to = safe;
  let reached = safe;
  while (to > floor && d.now() < deadline) {
    const from = Math.max(floor, to - chain.maxRange + 1);
    const logs = await getLogsHalving(d.read, { address: pool, topics: [spec.swapTopic] }, from, to);
    for (const raw of logs) {
      const s = decodeSwap(raw, spec.kind, spec.swapTopic);
      if (!s || s.pool !== pool || s.block < from || s.block > to) continue;
      let b = blocks.get(s.block);
      if (!b) {
        const got = await getBlock(d.read, s.block);
        if (!got) throw new RpcError(`block ${s.block} could not be read`, 'transport');
        b = { hash: got.hash, time: got.time };
        blocks.set(s.block, b);
      }
      if (b.hash !== s.blockHash) continue; // moved while being read: skipped, the next run of the follower reads it
      const t = tradeOf(stored as MiPool, s, b.time);
      if (t) trades.push(t);
    }
    reached = from;
    to = from - 1;
  }
  await d.store.putTrades(spec.id, trades);
  await refreshPool(deps, stored, trades, tokenFacts);
  return { status: 'tracked', key, trades: trades.length, alreadyKnown: false, coveredHours: Math.round(((safe - reached) / (BLOCKS_PER_HOUR[chain.id] ?? 1_800)) * 10) / 10 };
}
