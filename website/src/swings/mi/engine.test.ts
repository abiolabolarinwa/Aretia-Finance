import { describe, expect, it } from 'vitest';
import { chainConfig } from './chains.js';
import { specById } from './dexes.js';
import { runAdapter, type EngineDeps, type LaunchLookup } from './engine.js';
import { DEFAULT_RULES } from './lifecycle.js';
import { InMemoryMiStore } from './store.js';
import { FakeChain, pairCreatedLog, poolCreatedLog, v2SwapLog, v3SwapLog } from './testkit.js';

const spec = specById('pancakeswap-v2-bnb')!;
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const TOKEN = '0x' + 'a1'.repeat(20);
const OTHER = '0x' + 'b2'.repeat(20);
const POOL_W = '0x' + 'c3'.repeat(20);
const POOL_U = '0x' + 'c4'.repeat(20);
const E18 = 10n ** 18n;
const WHO = '0x' + '11'.repeat(20);

function setup(overrides: Partial<EngineDeps> = {}) {
  const chain = new FakeChain();
  chain.addToken(WBNB, 'WBNB', 18);
  chain.addToken(USDT, 'USDT', 18);
  chain.addToken(TOKEN, 'MEME', 18, 'Meme Token');
  chain.addToken(OTHER, 'OTH', 9);
  const store = new InMemoryMiStore();
  const cfg = { ...chainConfig('bnb', { MI_CONFIRMATIONS_BNB: '2' }), maxRange: 50, lookback: 100 };
  const now = () => (chain.blocks[chain.blocks.length - 1]!.time + 5) * 1000;
  const deps: EngineDeps = { spec, chain: cfg, read: chain.read, store, rules: DEFAULT_RULES, now, nativeUsd: async () => 600, ...overrides };
  return { chain, store, deps, now };
}

/** Pool of TOKEN (token0) against WBNB (token1) with some liquidity, created in the next block. */
function createPool(chain: FakeChain, pool = POOL_W, quote = WBNB, reserves: [bigint, bigint] = [1_000_000n * E18, 100n * E18]) {
  chain.reserves.set(pool, reserves);
  return chain.mine([pairCreatedLog(spec.factory, TOKEN, quote, pool)]);
}

describe('engine: discovery', () => {
  it('discovers a new pool automatically: pool, tokens, decimals, creation time, lifecycle', async () => {
    const { chain, store, deps } = setup();
    chain.mineEmpty(5);
    const created = createPool(chain);
    chain.mineEmpty(5);
    const r = await runAdapter(deps);
    expect(r.ok).toBe(true);
    expect(r.poolsNew).toBe(1);
    const pool = [...store.pools.values()][0]!;
    expect(pool.address).toBe(POOL_W);
    expect(pool.base).toBe(TOKEN);
    expect(pool.quote).toBe(WBNB);
    expect(pool.baseIsToken0).toBe(true);
    expect(pool.createdBlock).toBe(created.number);
    expect(pool.createdAt).toBe(created.time * 1000);
    expect(pool.state).toBe('active');
    expect(pool.reserveBase).toBe((1_000_000n * E18).toString());
    const token = (await store.getTokens([`bnb:${TOKEN}`])).get(`bnb:${TOKEN}`)!;
    expect(token).toMatchObject({ symbol: 'MEME', name: 'Meme Token', decimals: 18, firstTradeAt: null });
  });

  it('a pool with no liquidity is not a market yet', async () => {
    const { chain, store, deps } = setup();
    createPool(chain, POOL_W, WBNB, [0n, 0n]);
    chain.mineEmpty(5);
    await runAdapter(deps);
    expect([...store.pools.values()][0]!.state).toBe('awaiting_liquidity');
  });

  it('puts the recognised token on the quote side whichever order the factory lists them', async () => {
    const { chain, store, deps } = setup();
    chain.reserves.set(POOL_U, [200n * E18, 5_000_000n * E18]);
    chain.mine([pairCreatedLog(spec.factory, USDT, TOKEN, POOL_U)]);
    chain.mineEmpty(5);
    await runAdapter(deps);
    const p = [...store.pools.values()][0]!;
    expect([p.base, p.quote, p.baseIsToken0]).toEqual([TOKEN, USDT, false]);
  });

  it('a pair of two unknown tokens, or an unreadable token, is unsupported and never listed', async () => {
    const { chain, store, deps } = setup();
    chain.reserves.set(POOL_W, [1n, 1n]);
    chain.mine([pairCreatedLog(spec.factory, TOKEN, OTHER, POOL_W)]);
    const BROKEN = '0x' + 'd5'.repeat(20);
    chain.tokens.set(BROKEN, 'broken');
    chain.reserves.set(POOL_U, [1n, 1n]);
    chain.mine([pairCreatedLog(spec.factory, BROKEN, WBNB, POOL_U)]);
    chain.mineEmpty(5);
    await runAdapter(deps);
    expect([...store.pools.values()].map((p) => p.state)).toEqual(['unsupported', 'unsupported']);
  });

  it('links several pools to one token record', async () => {
    const { chain, store, deps } = setup();
    createPool(chain, POOL_W, WBNB);
    createPool(chain, POOL_U, USDT, [1_000_000n * E18, 60_000n * E18]);
    chain.mineEmpty(5);
    await runAdapter(deps);
    expect(store.pools.size).toBe(2);
    expect([...store.tokens.keys()].filter((k) => k === `bnb:${TOKEN}`)).toHaveLength(1);
    const page = await store.listPools({ tokenKey: `bnb:${TOKEN}`, sort: 'newest', limit: 10 });
    expect(page.pools).toHaveLength(2);
  });

  it('recognises an Aretia Launch Box token without creating a second record', async () => {
    const launch: LaunchLookup = { find: async (_c, addrs) => new Map(addrs.filter((a) => a === TOKEN).map((a) => [a, `bnb:${a}`])) };
    const first = setup({ launch });
    createPool(first.chain);
    first.chain.mineEmpty(5);
    await runAdapter(first.deps);
    // Another adapter later finds the same token in a second pool, on the same store.
    const ape = specById('apeswap-v2-bnb')!;
    const second = setup({ launch, spec: ape });
    second.chain.reserves.set(POOL_U, [1_000_000n * E18, 60_000n * E18]);
    second.chain.mine([pairCreatedLog(ape.factory, TOKEN, USDT, POOL_U)]);
    second.chain.mineEmpty(5);
    await runAdapter({ ...second.deps, store: first.store });
    const tokens = [...first.store.tokens.values()].filter((t) => t.address === TOKEN);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.launchboxKey).toBe(`bnb:${TOKEN}`);
    expect(first.store.pools.size).toBe(2);
  });
});

describe('engine: liquidity arriving later, and V3', () => {
  it('a pool funded after creation becomes active without needing a swap first', async () => {
    const { chain, store, deps } = setup();
    createPool(chain, POOL_W, WBNB, [0n, 0n]);
    chain.mineEmpty(5);
    await runAdapter(deps);
    expect([...store.pools.values()][0]!.state).toBe('awaiting_liquidity');
    chain.reserves.set(POOL_W, [1_000_000n * E18, 100n * E18]);
    chain.mineEmpty(3);
    await runAdapter(deps);
    expect([...store.pools.values()][0]!.state).toBe('active');
  });

  it('indexes a V3 pool: creation with fee tier, balances as liquidity, signed-amount swaps', async () => {
    const v3 = specById('uniswap-v3-bnb')!;
    const { chain, store, deps } = setup({ spec: v3 });
    chain.balances.set(`${TOKEN}|${POOL_W}`, 5_000_000n * E18);
    chain.balances.set(`${WBNB}|${POOL_W}`, 50n * E18);
    chain.mine([poolCreatedLog(v3.factory, TOKEN, WBNB, 2500, POOL_W)]);
    // pool received 1 WBNB (+), paid out 10,000 TOKEN (-): a buy
    chain.mine([v3SwapLog(POOL_W, -10_000n * E18, E18, WHO)]);
    chain.mineEmpty(5);
    const r = await runAdapter(deps);
    expect(r.ok).toBe(true);
    const pool = [...store.pools.values()][0]!;
    expect([pool.kind, pool.feeTier, pool.state]).toEqual(['v3', 2500, 'active']);
    expect([...store.trades.values()][0]).toMatchObject({ side: 'buy', price: '0.0001' });
  });
});

describe('engine: swaps, data and idempotence', () => {
  it('real swaps update trades, price, volume, buys/sells and candles', async () => {
    const { chain, store, deps } = setup();
    createPool(chain);
    chain.mineEmpty(2);
    // buy: pool receives 1 WBNB (token1 in) and pays 10,000 TOKEN (token0 out)
    chain.mine([v2SwapLog(POOL_W, { in1: E18, out0: 10_000n * E18 }, WHO)]);
    // sell: pool receives 5,000 TOKEN, pays 0.4 WBNB
    chain.mine([v2SwapLog(POOL_W, { in0: 5_000n * E18, out1: (4n * E18) / 10n }, '0x' + '22'.repeat(20))]);
    chain.mineEmpty(5);
    const r = await runAdapter(deps);
    expect(r.tradesNew).toBe(2);
    const trades = await store.tradesSince('bnb', POOL_W, 0, 100);
    expect(trades.map((t) => [t.side, t.price])).toEqual([['buy', '0.0001'], ['sell', '0.00008']]);
    const pool = [...store.pools.values()][0]!;
    expect(pool.stats!.buys.h24).toBe(1);
    expect(pool.stats!.sells.h24).toBe(1);
    expect(pool.stats!.volumeQuote.h24).toBeCloseTo(1.4, 10);
    expect(pool.stats!.price).toBe('0.00008');
    expect(pool.stats!.change.h24).toBe(-2000);
    expect(pool.stats!.priceUsd).toBeCloseTo(0.048, 10); // native price supplied by the dependency, never invented
    expect(pool.firstTradeAt).toBe(trades[0]!.time * 1000);
    expect((await store.getTokens([`bnb:${TOKEN}`])).get(`bnb:${TOKEN}`)!.firstTradeAt).toBe(trades[0]!.time * 1000);
  });

  it('ignores a swap that is not a trade of base against quote', async () => {
    const { chain, store, deps } = setup();
    createPool(chain);
    chain.mine([v2SwapLog(POOL_W, { in0: 5n, out0: 5n }, WHO)]);
    chain.mineEmpty(5);
    await runAdapter(deps);
    expect(store.trades.size).toBe(0);
  });

  it('rerunning the same range duplicates nothing', async () => {
    const { chain, store, deps } = setup();
    createPool(chain);
    chain.mine([v2SwapLog(POOL_W, { in1: E18, out0: 10_000n * E18 }, WHO)]);
    chain.mineEmpty(5);
    await runAdapter(deps);
    const snapshot = { pools: store.pools.size, trades: store.trades.size, tokens: store.tokens.size };
    // The cursor is lost: a full re-read from the start of the range must reach the same state.
    await runAdapter(deps, { range: { from: chain.startBlock, to: chain.head } });
    expect({ pools: store.pools.size, trades: store.trades.size, tokens: store.tokens.size }).toEqual(snapshot);
  });

  it('a crash before the checkpoint is written loses nothing and duplicates nothing', async () => {
    const { chain, store, deps } = setup();
    createPool(chain);
    chain.mine([v2SwapLog(POOL_W, { in1: E18, out0: 10_000n * E18 }, WHO)]);
    chain.mineEmpty(5);
    const real = store.setCheckpoint.bind(store);
    let crash = true;
    store.setCheckpoint = async (c) => {
      if (crash) throw new Error('process killed');
      return real(c);
    };
    const first = await runAdapter(deps);
    expect(first.ok).toBe(false);
    expect(await store.getCheckpoint(spec.id)).toBeNull();
    crash = false;
    const second = await runAdapter(deps);
    expect(second.ok).toBe(true);
    expect(store.trades.size).toBe(1);
    expect(store.pools.size).toBe(1);
    expect((await store.getCheckpoint(spec.id))!.block).toBe(chain.head - 2);
  });

  it('recovers after downtime by catching up chunk by chunk, in order', async () => {
    const { chain, store, deps } = setup();
    createPool(chain);
    chain.mineEmpty(10);
    await runAdapter(deps);
    const cp1 = (await store.getCheckpoint(spec.id))!.block;
    // The worker is down while the chain advances by 400 blocks with swaps spread across them.
    for (let i = 0; i < 8; i++) {
      chain.mine([v2SwapLog(POOL_W, { in1: E18, out0: BigInt(10_000 + i) * E18 }, WHO)]);
      chain.mineEmpty(49);
    }
    const r = await runAdapter(deps);
    expect(r.ok).toBe(true);
    expect(r.tradesNew).toBe(8);
    expect((await store.getCheckpoint(spec.id))!.block).toBe(chain.head - 2);
    expect((await store.getCheckpoint(spec.id))!.block).toBeGreaterThan(cp1);
    expect((await store.listHealth())[0]!.lagBlocks).toBe(0);
  });

  it('a transport failure leaves the cursor, is recorded, and the next run succeeds', async () => {
    const { chain, store, deps } = setup();
    createPool(chain);
    chain.mineEmpty(5);
    chain.failNext = 1;
    const bad = await runAdapter(deps);
    expect(bad.ok).toBe(false);
    expect((await store.listHealth())[0]!.consecutiveFailures).toBe(1);
    expect(await store.getCheckpoint(spec.id)).toBeNull();
    const good = await runAdapter(deps);
    expect(good.ok).toBe(true);
    expect((await store.listHealth())[0]!.consecutiveFailures).toBe(0);
  });

  it('halves a log range that the node refuses', async () => {
    const { chain, store, deps } = setup();
    chain.maxLogRange = 7;
    createPool(chain);
    chain.mine([v2SwapLog(POOL_W, { in1: E18, out0: 10_000n * E18 }, WHO)]);
    chain.mineEmpty(30);
    const r = await runAdapter(deps);
    expect(r.ok).toBe(true);
    expect(store.trades.size).toBe(1);
  });
});

describe('engine: reorgs and controls', () => {
  it('detects a reorg, deletes what was written above the fork, and re-reads the new chain', async () => {
    const { chain, store, deps } = setup();
    createPool(chain);
    chain.mineEmpty(10);
    await runAdapter(deps); // checkpoint 1
    const forkAfter = (await store.getCheckpoint(spec.id))!.block;
    const swapBlock = chain.mine([v2SwapLog(POOL_W, { in1: E18, out0: 10_000n * E18 }, WHO)]).number;
    chain.mineEmpty(5);
    await runAdapter(deps); // ingests the swap, checkpoint 2
    expect(store.trades.size).toBe(1);
    // The chain reorganises from just after checkpoint 1; the swap now has a different price.
    chain.reorg(forkAfter, (n) => (n === swapBlock ? [v2SwapLog(POOL_W, { in1: 2n * E18, out0: 10_000n * E18 }, '0x' + '33'.repeat(20))] : []));
    chain.mineEmpty(3);
    const r = await runAdapter(deps);
    expect(r.ok).toBe(true);
    expect(r.reorg).not.toBeNull();
    expect(r.reorg!.tradesDeleted).toBe(1);
    expect(store.trades.size).toBe(1);
    expect([...store.trades.values()][0]!.price).toBe('0.0002');
    expect((await store.getCheckpoint(spec.id))!.block).toBe(chain.head - 2);
  });

  it('a pool created in a reorged-away block is removed', async () => {
    const { chain, store, deps } = setup();
    chain.mineEmpty(3);
    await runAdapter(deps);
    const forkAfter = (await store.getCheckpoint(spec.id))!.block;
    createPool(chain);
    chain.mineEmpty(5);
    await runAdapter(deps);
    expect(store.pools.size).toBe(1);
    chain.reorg(forkAfter);
    chain.mineEmpty(2);
    await runAdapter(deps);
    expect(store.pools.size).toBe(0);
  });

  it('does nothing while an adapter is disabled, and resumes when enabled', async () => {
    const { chain, store, deps } = setup();
    createPool(chain);
    chain.mineEmpty(5);
    await store.setAdapterDisabled(spec.id, true, 'test', 1);
    const r = await runAdapter(deps);
    expect(r.skipped).toBe('disabled');
    expect(store.pools.size).toBe(0);
    await store.setAdapterDisabled(spec.id, false, '', 2);
    expect((await runAdapter(deps)).poolsNew).toBe(1);
  });

  it('does not follow swaps of a paused market', async () => {
    const { chain, store, deps } = setup();
    createPool(chain);
    chain.mineEmpty(5);
    await runAdapter(deps);
    const key = `bnb:${POOL_W}`;
    await store.updatePool(key, { paused: true, state: 'suspended' });
    chain.mine([v2SwapLog(POOL_W, { in1: E18, out0: 10_000n * E18 }, WHO)]);
    chain.mineEmpty(5);
    await runAdapter(deps);
    expect(store.trades.size).toBe(0);
    expect(store.pools.get(key)!.state).toBe('suspended');
  });

  it('an explicit backfill range re-processes without moving the checkpoint', async () => {
    const { chain, store, deps } = setup();
    createPool(chain);
    chain.mine([v2SwapLog(POOL_W, { in1: E18, out0: 10_000n * E18 }, WHO)]);
    chain.mineEmpty(10);
    await runAdapter(deps);
    const cp = await store.getCheckpoint(spec.id);
    const r = await runAdapter(deps, { range: { from: chain.startBlock, to: chain.head - 2 } });
    expect(r.ok).toBe(true);
    expect(r.tradesNew).toBe(0);
    expect(await store.getCheckpoint(spec.id)).toEqual(cp);
  });
});
