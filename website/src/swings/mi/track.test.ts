import { describe, expect, it } from 'vitest';
import { chainConfig } from './chains.js';
import { specById } from './dexes.js';
import { DEFAULT_RULES } from './lifecycle.js';
import { InMemoryMiStore } from './store.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeCreation } from './decode.js';
import { deepenHistory, trackEvmPool, v4KeyFromToken, v4PoolId } from './track.js';
import { FakeChain, initializeLog, poolCreatedLog, v2SwapLog, v3SwapLog, v4SwapLog } from './testkit.js';

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

describe('Uniswap V4 pool ids', () => {
  const real = JSON.parse(readFileSync(join(process.cwd(), 'src/swings/mi/fixtures/real-logs.json'), 'utf8')) as Record<string, { poolInit: unknown; pool: { address: string } }>;

  it('the id is the keccak256 of the ABI-encoded key: proven on every real Initialize log captured', () => {
    for (const id of ['uniswap-v4-ethereum', 'uniswap-v4-base', 'uniswap-v4-polygon', 'uniswap-v4-bnb', 'uniswap-v4-robinhood']) {
      const spec = specById(id)!;
      const c = decodeCreation(real[id]!.poolInit, 'v4', spec.factory)!;
      expect(v4PoolId({ currency0: c.token0, currency1: c.token1, fee: c.feeTier!, tickSpacing: c.tickSpacing!, hooks: c.hooks! })).toBe(c.pool);
      expect(c.pool).toBe(real[id]!.pool.address);
    }
  });

  it('finds a hookless standard key from one token by hashing, and refuses what does not hash to the id', () => {
    const NATIVE = '0x' + '0'.repeat(40);
    const key = { currency0: NATIVE, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: NATIVE };
    const id = v4PoolId(key);
    expect(v4KeyFromToken(id, TOKEN, [WBNB, NATIVE])).toEqual(key);
    expect(v4KeyFromToken(id, TOKEN, [WBNB])).toBeNull();
    expect(v4KeyFromToken('0x' + '12'.repeat(32), TOKEN, [WBNB, NATIVE])).toBeNull();
  });
});

describe('history of a tracked pool', () => {
  const v4 = specById('uniswap-v4-bnb')!;
  const NATIVE = '0x' + '0'.repeat(40);

  it('a V4 pool added on request gets its real creation time from the Initialize event and a history that deepens run by run until its creation', async () => {
    const chain = new FakeChain(1000, 1_700_000_000, 30);
    chain.addToken(TOKEN, 'V4T', 18, 'V4 Token');
    const key = { currency0: NATIVE, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: NATIVE };
    const id = v4PoolId(key);
    chain.v4States.set(id, { sqrtPriceX96: 100n * (1n << 96n), tick: 92_000, liquidity: 10n ** 27n });
    chain.mineEmpty(10);
    const creationBlock = chain.mine([initializeLog(v4.factory, id, NATIVE, TOKEN, 3000, 60, NATIVE)]).number;
    // Swaps spread over the next 600 blocks.
    for (let i = 0; i < 6; i++) {
      chain.mine([v4SwapLog(v4.factory, id, -E18, 10_000n * E18, WHO)]);
      chain.mineEmpty(99);
    }
    chain.mineEmpty(5);
    const store = new InMemoryMiStore();
    const cfg = { ...chainConfig('bnb', { MI_CONFIRMATIONS_BNB: '2' }), maxRange: 100 };
    const now = () => (chain.blocks[chain.blocks.length - 1]!.time + 5) * 1000;
    const deps = { chain: cfg, read: chain.read, store, rules: DEFAULT_RULES, now, nativeUsd: async () => 600 };
    // A deliberately short first window: the last 200 blocks only (hours = 200 blocks / 4,800 per hour).
    const r = await trackEvmPool({ ...deps, backfillHours: 200 / 4_800 }, cfg, id);
    expect(r).toMatchObject({ status: 'tracked', alreadyKnown: false, complete: false });
    const pool = [...store.pools.values()][0]!;
    expect([pool.createdBlock, pool.createdAt > 0, pool.historyDone]).toEqual([creationBlock, true, false]);
    const first = store.trades.size;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(6);
    // Each run reads further back, then stops at the creation block.
    const full = { ...deps, spec: v4 };
    let done = false;
    for (let i = 0; i < 10 && !done; i++) {
      await deepenHistory(full, { chunksPerPool: 2 });
      done = [...store.pools.values()][0]!.historyDone;
    }
    expect(done).toBe(true);
    expect(store.trades.size).toBe(6);
    // Nothing more to read: a further call does nothing.
    expect(await deepenHistory(full)).toEqual({ pools: 0, trades: 0, completed: 0 });
  });

  it('a V3 pool added on request also gets its creation found, through PoolCreated\'s indexed fields', async () => {
    const v3 = specById('uniswap-v3-bnb')!;
    const chain = new FakeChain(1000, 1_700_000_000, 30);
    chain.addToken(WBNB, 'WBNB', 18);
    chain.addToken(TOKEN, 'OLD', 18);
    chain.pairs.set(POOL, { factory: v3.factory, token0: TOKEN, token1: WBNB, fee: 2500 });
    chain.balances.set(`${TOKEN}|${POOL}`, 5_000_000n * E18);
    chain.balances.set(`${WBNB}|${POOL}`, 50n * E18);
    chain.mineEmpty(5);
    const created = chain.mine([poolCreatedLog(v3.factory, TOKEN, WBNB, 2500, POOL)]);
    chain.mine([v3SwapLog(POOL, -10_000n * E18, E18, WHO)]);
    chain.mineEmpty(20);
    const store = new InMemoryMiStore();
    const cfg = { ...chainConfig('bnb', { MI_CONFIRMATIONS_BNB: '2' }), maxRange: 50 };
    const now = () => (chain.blocks[chain.blocks.length - 1]!.time + 5) * 1000;
    const r = await trackEvmPool({ chain: cfg, read: chain.read, store, rules: DEFAULT_RULES, now, nativeUsd: async () => 600 }, cfg, POOL);
    expect(r).toMatchObject({ status: 'tracked', trades: 1, complete: true });
    const pool = [...store.pools.values()][0]!;
    expect([pool.createdBlock, pool.createdAt, pool.historyDone]).toEqual([created.number, created.time * 1000, true]);
  });
});
