import { describe, expect, it } from 'vitest';
import { chainConfig } from './chains.js';
import { specById } from './dexes.js';
import { DEFAULT_RULES } from './lifecycle.js';
import { InMemoryMiStore } from './store.js';
import { trackEvmPool } from './track.js';
import { FakeChain, v2SwapLog } from './testkit.js';

const spec = specById('pancakeswap-v2-bnb')!;
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const TOKEN = '0x' + 'a1'.repeat(20);
const POOL = '0x' + 'c3'.repeat(20);
const E18 = 10n ** 18n;
const WHO = '0x' + '11'.repeat(20);

function setup() {
  const chain = new FakeChain();
  chain.addToken(WBNB, 'WBNB', 18);
  chain.addToken(TOKEN, 'OLD', 18, 'Old Token');
  chain.reserves.set(POOL, [1_000_000n * E18, 100n * E18]);
  chain.pairs.set(POOL, { factory: spec.factory, token0: TOKEN, token1: WBNB });
  const store = new InMemoryMiStore();
  const cfg = { ...chainConfig('bnb', { MI_CONFIRMATIONS_BNB: '2' }), maxRange: 50 };
  const now = () => (chain.blocks[chain.blocks.length - 1]!.time + 5) * 1000;
  return { chain, store, deps: { chain: cfg, read: chain.read, store, rules: DEFAULT_RULES, now, nativeUsd: async () => 600 }, cfg };
}

describe('tracking an existing pool on request', () => {
  it('registers an old pool and reads its recent swaps, with an unknown creation time', async () => {
    const { chain, store, deps, cfg } = setup();
    chain.mineEmpty(20);
    chain.mine([v2SwapLog(POOL, { in1: E18, out0: 10_000n * E18 }, WHO)]);
    chain.mineEmpty(5);
    chain.mine([v2SwapLog(POOL, { in0: 5_000n * E18, out1: (4n * E18) / 10n }, WHO)]);
    chain.mineEmpty(10);
    const r = await trackEvmPool({ ...deps, backfillHours: 1 }, cfg, POOL.toUpperCase().replace('0X', '0x'));
    expect(r).toMatchObject({ status: 'tracked', alreadyKnown: false, trades: 2 });
    const pool = [...store.pools.values()][0]!;
    expect([pool.address, pool.adapterId, pool.createdAt, pool.createdTx, pool.state]).toEqual([POOL, spec.id, 0, 'tracked', 'active']);
    expect(pool.stats!.buys.h24).toBe(1);
    expect(pool.stats!.sells.h24).toBe(1);
    expect(store.tokens.size).toBe(2);
    // Asking again changes nothing.
    expect(await trackEvmPool(deps, cfg, POOL)).toMatchObject({ status: 'tracked', alreadyKnown: true });
    expect(store.trades.size).toBe(2);
  });

  it('refuses a contract that is not a pool of a catalogued DEX, and a non-address', async () => {
    const { chain, store, deps, cfg } = setup();
    chain.pairs.set('0x' + 'd4'.repeat(20), { factory: '0x' + 'ee'.repeat(20), token0: TOKEN, token1: WBNB });
    expect((await trackEvmPool(deps, cfg, '0x' + 'd4'.repeat(20))).status).toBe('unsupported');
    expect((await trackEvmPool(deps, cfg, '0x' + '99'.repeat(20))).status).toBe('unsupported');
    expect((await trackEvmPool(deps, cfg, 'nope')).status).toBe('unsupported');
    expect(store.pools.size).toBe(0);
  });

  it('a tracked pool is then followed by the normal run, and its swaps are not stored twice', async () => {
    const { chain, store, deps, cfg } = setup();
    chain.mine([v2SwapLog(POOL, { in1: E18, out0: 10_000n * E18 }, WHO)]);
    chain.mineEmpty(10);
    await trackEvmPool({ ...deps, backfillHours: 1 }, cfg, POOL);
    const { runAdapter } = await import('./engine.js');
    chain.mine([v2SwapLog(POOL, { in1: 2n * E18, out0: 10_000n * E18 }, WHO)]);
    chain.mineEmpty(10);
    await runAdapter({ ...deps, spec, chain: { ...cfg, lookback: 100 } });
    expect(store.trades.size).toBe(2);
  });
});
