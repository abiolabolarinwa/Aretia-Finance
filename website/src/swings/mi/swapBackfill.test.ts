import { describe, expect, it } from 'vitest';
import { chainConfig } from './chains.js';
import { specById } from './dexes.js';
import { runAdapter, type EngineDeps } from './engine.js';
import { DEFAULT_RULES } from './lifecycle.js';
import { InMemoryMiStore } from './store.js';
import { backfillSwaps, interpolateTime, swapBackfillKey, swapBackfillRangeOf } from './swapBackfill.js';
import { FakeChain, pairCreatedLog, v2SwapLog } from './testkit.js';

const spec = specById('pancakeswap-v2-bnb')!;
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const TOKEN = '0x' + 'a1'.repeat(20);
const TOKEN2 = '0x' + 'a2'.repeat(20);
const POOL_A = '0x' + 'c3'.repeat(20);
const POOL_B = '0x' + 'c4'.repeat(20);
const STRANGER = '0x' + 'd9'.repeat(20);
const E18 = 10n ** 18n;
const WHO = '0x' + '11'.repeat(20);

function world() {
  const chain = new FakeChain();
  chain.addToken(WBNB, 'WBNB', 18);
  chain.addToken(TOKEN, 'MEME', 18);
  chain.addToken(TOKEN2, 'TWO', 18);
  chain.reserves.set(POOL_A, [1_000_000n * E18, 100n * E18]);
  chain.reserves.set(POOL_B, [2_000_000n * E18, 150n * E18]);
  const store = new InMemoryMiStore();
  const cfg = { ...chainConfig('bnb', { MI_CONFIRMATIONS_BNB: '2' }), maxRange: 7, lookback: 1_000 };
  const now = () => (chain.blocks[chain.blocks.length - 1]!.time + 5) * 1000;
  // The pools are created and the swaps happen, then the live adapter starts after them: the swaps are in its past, never stored.
  chain.mine([pairCreatedLog(spec.factory, TOKEN, WBNB, POOL_A), pairCreatedLog(spec.factory, TOKEN2, WBNB, POOL_B)]);
  chain.mine([v2SwapLog(POOL_A, { in1: E18, out0: 10_000n * E18 }, WHO), v2SwapLog(STRANGER, { in1: E18, out0: 5n * E18 }, WHO)]);
  chain.mineEmpty(12);
  chain.mine([v2SwapLog(POOL_B, { in1: E18, out0: 12_000n * E18 }, WHO), v2SwapLog(POOL_A, { out1: E18, in0: 9_000n * E18 }, WHO)]);
  chain.mineEmpty(30);
  const live: EngineDeps = { spec, chain: cfg, read: chain.read, store, rules: DEFAULT_RULES, now, nativeUsd: async () => 600, followNewest: 0, followRecent: 0 };
  return { chain, store, cfg, now, live };
}

const deps = (w: ReturnType<typeof world>, over: Partial<Parameters<typeof backfillSwaps>[0]> = {}) => ({ spec, chain: w.cfg, read: w.chain.read, store: w.store, rules: DEFAULT_RULES, now: w.now, budgetMs: 60_000, days: 1, ...over });

describe('swap-history backfill', () => {
  it('waits for the live adapter to have a checkpoint, and does nothing for V4', async () => {
    const w = world();
    const r = await backfillSwaps(deps(w));
    expect(r.state).toBe('skipped');
    expect(r.skipped).toBe('no-live-checkpoint');
    expect(w.store.trades.size).toBe(0);
  });

  it('stores the past swaps of registered pools only, marks their first and last trade, and finishes', async () => {
    const w = world();
    // The live adapter starts at the head, registering the pools through a creation backfill range it has not read: register by range.
    await runAdapter({ ...w.live, followNewest: 0 }, { range: { from: w.chain.startBlock, to: w.chain.head - 6 } });
    const checkpointBefore = await w.store.getCheckpoint(spec.id);
    expect(checkpointBefore).toBeNull(); // a range run does not move the live checkpoint
    // Give it a live checkpoint at the head, as a running worker would have.
    await w.store.setCheckpoint({ adapterId: spec.id, block: w.chain.head, blockHash: w.chain.blocks[w.chain.blocks.length - 1]!.hash, updatedAt: 1 });
    w.store.trades.clear(); // the range run above already stored them; the backfill must find them by itself
    for (const p of w.store.pools.values()) await w.store.updatePool(p.key, { firstTradeAt: null, lastTradeAt: null });
    expect([...w.store.pools.values()].every((p) => p.lastTradeAt === null)).toBe(true);
    const r = await backfillSwaps(deps(w));
    expect(r.ok).toBe(true);
    expect(r.state).toBe('done');
    expect(new Set([...w.store.trades.values()].map((t) => t.pool))).toEqual(new Set([POOL_A, POOL_B])); // the stranger's swap is ignored
    expect(w.store.trades.size).toBe(3);
    const a = [...w.store.pools.values()].find((p) => p.address === POOL_A)!;
    expect(a.firstTradeAt).not.toBeNull();
    expect(a.lastTradeAt!).toBeGreaterThanOrEqual(a.firstTradeAt!);
    expect((await w.store.getCheckpoint(swapBackfillKey(spec.id, 1)))?.blockHash).toBe('done');
  });

  it('is idempotent: a second run stores nothing, and a finished walk is not walked again', async () => {
    const w = world();
    await runAdapter({ ...w.live }, { range: { from: w.chain.startBlock, to: w.chain.head - 6 } });
    await w.store.setCheckpoint({ adapterId: spec.id, block: w.chain.head, blockHash: w.chain.blocks[w.chain.blocks.length - 1]!.hash, updatedAt: 1 });
    w.store.trades.clear();
    await backfillSwaps(deps(w));
    const n = w.store.trades.size;
    const calls = w.chain.calls.length;
    const again = await backfillSwaps(deps(w));
    expect(again.state).toBe('done');
    expect(w.store.trades.size).toBe(n);
    expect(w.chain.calls.length - calls).toBeLessThanOrEqual(2); // only the disabled-adapter check and nothing from the chain
    // starting over from a cleared checkpoint reads the same range and still stores no duplicate
    await w.store.setCheckpoint({ adapterId: swapBackfillKey(spec.id, 1), block: 0, blockHash: 'walking', updatedAt: 1 });
    await backfillSwaps(deps(w));
    expect(w.store.trades.size).toBe(n);
  });

  it('never moves a pool\'s last trade backwards when a newer live trade exists', async () => {
    const w = world();
    await runAdapter({ ...w.live }, { range: { from: w.chain.startBlock, to: w.chain.head - 6 } });
    await w.store.setCheckpoint({ adapterId: spec.id, block: w.chain.head, blockHash: w.chain.blocks[w.chain.blocks.length - 1]!.hash, updatedAt: 1 });
    const a = [...w.store.pools.values()].find((p) => p.address === POOL_A)!;
    const newer = (w.chain.blocks[w.chain.blocks.length - 1]!.time + 1_000) * 1000;
    await w.store.updatePool(a.key, { lastTradeAt: newer });
    await backfillSwaps(deps(w));
    expect([...w.store.pools.values()].find((p) => p.address === POOL_A)!.lastTradeAt).toBe(newer);
  });
});

describe('blocks per request for the walk', () => {
  it('uses the own range of each chain, except Robinhood, whose node takes far more and whose blocks are very fast', () => {
    expect(swapBackfillRangeOf(chainConfig('ethereum'))).toBe(500);
    expect(swapBackfillRangeOf(chainConfig('bnb'))).toBe(1000);
    expect(swapBackfillRangeOf(chainConfig('robinhood'))).toBe(25_000);
  });
});

describe('time of a swap inside a block range', () => {
  it('is interpolated between the times at the ends and never leaves them', () => {
    const a = { block: 100, time: 1_000 };
    const b = { block: 200, time: 1_300 };
    expect(interpolateTime(a, b, 100)).toBe(1_000);
    expect(interpolateTime(a, b, 150)).toBe(1_150);
    expect(interpolateTime(a, b, 200)).toBe(1_300);
    expect(interpolateTime(a, b, 90)).toBe(1_000);
    expect(interpolateTime(a, b, 250)).toBe(1_300);
    expect(interpolateTime(a, a, 100)).toBe(1_000);
  });
});
