import { describe, expect, it } from 'vitest';
import { chainConfig } from './chains.js';
import { specById } from './dexes.js';
import { runAdapter, type EngineDeps } from './engine.js';
import { DEFAULT_RULES } from './lifecycle.js';
import { InMemoryMiStore } from './store.js';
import { swapScanChains, type ScanCache } from './swapScan.js';
import { FakeChain, pairCreatedLog, v2SwapLog } from './testkit.js';

const spec = specById('pancakeswap-v2-bnb')!;
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const TOKEN = '0x' + 'a1'.repeat(20);
const TOKEN2 = '0x' + 'a2'.repeat(20);
const POOL_A = '0x' + 'c3'.repeat(20);
const POOL_B = '0x' + 'c4'.repeat(20);
const STRANGER = '0x' + 'd9'.repeat(20); // emits the same swap event but was never registered
const FORK = '0x' + 'e5'.repeat(20); // registered, but by another adapter
const E18 = 10n ** 18n;
const WHO = '0x' + '11'.repeat(20);

function setup(over: Partial<EngineDeps> = {}, maxLogRange = Number.POSITIVE_INFINITY) {
  const chain = new FakeChain();
  chain.maxLogRange = maxLogRange;
  chain.addToken(WBNB, 'WBNB', 18);
  chain.addToken(USDT, 'USDT', 18);
  chain.addToken(TOKEN, 'MEME', 18);
  chain.addToken(TOKEN2, 'TWO', 18);
  const store = new InMemoryMiStore();
  const cfg = { ...chainConfig('bnb', { MI_CONFIRMATIONS_BNB: '2' }), maxRange: 50, lookback: 100 };
  const now = () => (chain.blocks[chain.blocks.length - 1]!.time + 5) * 1000;
  const scanCache: ScanCache = { pools: new Map() };
  const deps: EngineDeps = { spec, chain: cfg, read: chain.read, store, rules: DEFAULT_RULES, now, nativeUsd: async () => 600, followNewest: 0, followRecent: 0, swapScan: true, scanCache, ...over };
  return { chain, store, deps, scanCache };
}

function twoPools(chain: FakeChain) {
  chain.reserves.set(POOL_A, [1_000_000n * E18, 100n * E18]);
  chain.reserves.set(POOL_B, [2_000_000n * E18, 150n * E18]);
  chain.mine([pairCreatedLog(spec.factory, TOKEN, WBNB, POOL_A), pairCreatedLog(spec.factory, TOKEN2, WBNB, POOL_B)]);
  chain.mineEmpty(3);
}

describe('chain-wide swap scan', () => {
  it('stores the swaps of every registered pool from one event request, and ignores everyone else', async () => {
    const { chain, store, deps } = setup();
    twoPools(chain);
    await runAdapter(deps); // registers both pools
    // a registered pool of another adapter, and a stranger, emit the same event
    const a = [...store.pools.values()].find((p) => p.address === POOL_A)!;
    await store.insertPool({ ...a, key: `bnb:${FORK}`, address: FORK, adapterId: 'uniswap-v2-bnb' });
    chain.mine([
      v2SwapLog(POOL_A, { in1: E18, out0: 10_000n * E18 }, WHO),
      v2SwapLog(POOL_B, { in1: E18, out0: 12_000n * E18 }, WHO),
      v2SwapLog(STRANGER, { in1: E18, out0: 5n * E18 }, WHO),
      v2SwapLog(FORK, { in1: E18, out0: 5n * E18 }, WHO),
    ]);
    chain.mineEmpty(3);
    const before = chain.calls.filter((c) => c === 'eth_getLogs').length;
    const r = await runAdapter(deps);
    expect(r.ok).toBe(true);
    expect(r.swapsSeen).toBe(2);
    expect(new Set([...store.trades.values()].map((t) => t.pool))).toEqual(new Set([POOL_A, POOL_B]));
    // one creation request and one swap request for the range, however many pools there are
    expect(chain.calls.filter((c) => c === 'eth_getLogs').length - before).toBe(2);
    // the traded pools now carry real trade numbers
    const stats = [...store.pools.values()].find((p) => p.address === POOL_A)!.stats!;
    expect(stats.reservesOnly).not.toBe(true);
    expect(stats.price).not.toBeNull();
  });

  it('without the scan and without following, the same swaps are not seen (the control)', async () => {
    const { chain, store, deps } = setup({ swapScan: false });
    twoPools(chain);
    await runAdapter(deps);
    chain.mine([v2SwapLog(POOL_A, { in1: E18, out0: 10_000n * E18 }, WHO)]);
    chain.mineEmpty(3);
    const r = await runAdapter(deps);
    expect(r.swapsSeen).toBe(0);
    expect(store.trades.size).toBe(0);
  });

  it('sees a swap of a pool registered in the same range', async () => {
    const { chain, store, deps } = setup();
    chain.reserves.set(POOL_A, [1_000_000n * E18, 100n * E18]);
    chain.mine([pairCreatedLog(spec.factory, TOKEN, WBNB, POOL_A)]);
    chain.mine([v2SwapLog(POOL_A, { in1: E18, out0: 10_000n * E18 }, WHO)]);
    chain.mineEmpty(3);
    const r = await runAdapter(deps);
    expect(r.swapsSeen).toBe(1);
    expect(store.trades.size).toBe(1);
  });

  it('remembers pools it does not hold, so they are not looked up again', async () => {
    const { chain, store, deps } = setup();
    twoPools(chain);
    await runAdapter(deps);
    let asked: string[] = [];
    const real = store.getPools.bind(store);
    store.getPools = async (keys) => {
      asked = [...asked, ...keys];
      return real(keys);
    };
    chain.mine([v2SwapLog(STRANGER, { in1: E18, out0: E18 }, WHO)]);
    chain.mineEmpty(3);
    await runAdapter(deps);
    chain.mine([v2SwapLog(STRANGER, { in1: E18, out0: E18 }, WHO)]);
    chain.mineEmpty(3);
    await runAdapter(deps);
    expect(asked.filter((k) => k === `bnb:${STRANGER}`)).toHaveLength(1);
  });

  it('splits a range the node refuses as too big, and still finds the swaps', async () => {
    const { chain, store, deps } = setup({}, 6);
    twoPools(chain);
    await runAdapter(deps);
    for (let i = 0; i < 3; i++) chain.mine([v2SwapLog(POOL_A, { in1: E18, out0: 10_000n * E18 }, WHO)]);
    chain.mineEmpty(12);
    const r = await runAdapter(deps);
    expect(r.ok).toBe(true);
    expect(store.trades.size).toBe(3);
  });

  it('is read from MI_SWAP_SCAN as a list of chains', () => {
    expect([...swapScanChains('ethereum, Base;bnb')].sort()).toEqual(['base', 'bnb', 'ethereum']);
    expect(swapScanChains(undefined).size).toBe(0);
    expect(swapScanChains('  ').size).toBe(0);
  });
});
