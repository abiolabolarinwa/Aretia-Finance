import { describe, expect, it } from 'vitest';
import { specById } from './dexes.js';
import { DEFAULT_ADAPTERS, enabledSpecs, rulesFrom, runAll } from './runner.js';
import { InMemoryMiStore } from './store.js';
import { FakeChain, pairCreatedLog, v2SwapLog } from './testkit.js';

const spec = specById('pancakeswap-v2-bnb')!;
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const TOKEN = '0x' + 'a1'.repeat(20);
const POOL = '0x' + 'c3'.repeat(20);
const E18 = 10n ** 18n;

describe('runner', () => {
  it('runs only the demonstrated adapter by default, and what the environment names otherwise', () => {
    expect(enabledSpecs({}).map((s) => s.id)).toEqual(DEFAULT_ADAPTERS);
    expect(enabledSpecs({ MI_ADAPTERS: 'uniswap-v3-base, nope ,apeswap-v2-bnb' }).map((s) => s.id)).toEqual(['uniswap-v3-base', 'apeswap-v2-bnb']);
    expect(enabledSpecs({ MI_ADAPTERS: '*' }).length).toBeGreaterThan(20);
  });

  it('listing rules come from the environment, ignoring nonsense', () => {
    expect(rulesFrom({ MI_MIN_LIQUIDITY_USD: '2500', MI_INACTIVE_AFTER_HOURS: '12' })).toMatchObject({ minLiquidityUsd: 2500, inactiveAfterMs: 12 * 3_600_000 });
    expect(rulesFrom({ MI_MIN_LIQUIDITY_USD: 'abc', MI_INACTIVE_AFTER_HOURS: '-3' }).minLiquidityUsd).toBe(500);
  });

  it('a scheduled run discovers, then an admin backfill job is claimed, advanced and completed', async () => {
    const chain = new FakeChain();
    chain.addToken(WBNB, 'WBNB', 18);
    chain.addToken('0x55d398326f99059ff775485246999027b3197955', 'USDT', 18);
    chain.addToken(TOKEN, 'MEME', 18);
    chain.reserves.set(POOL, [1_000_000n * E18, 100n * E18]);
    chain.mineEmpty(3);
    chain.mine([pairCreatedLog(spec.factory, TOKEN, WBNB, POOL)]);
    chain.mine([v2SwapLog(POOL, { in1: E18, out0: 10_000n * E18 }, '0x' + '11'.repeat(20))]);
    chain.mineEmpty(40);
    const store = new InMemoryMiStore();
    const now = () => (chain.blocks[chain.blocks.length - 1]!.time + 5) * 1000;
    const env = { MI_ADAPTERS: spec.id, MI_CONFIRMATIONS_BNB: '2' };
    const first = await runAll({ env, store, now, budgetMs: 30_000, readFor: () => chain.read });
    expect(first.adapters[0]!.ok).toBe(true);
    expect(store.pools.size).toBe(1);
    expect(first.job).toBeNull();

    await store.createJob({ id: 'j1', adapterId: spec.id, fromBlock: chain.startBlock, toBlock: chain.head - 2, doneBlock: chain.startBlock - 1, status: 'pending', requestedBy: 'owner', requestedAt: 1, error: null });
    const second = await runAll({ env, store, now, budgetMs: 30_000, readFor: () => chain.read });
    expect(second.job).toMatchObject({ id: 'j1', status: 'done' });
    expect(store.jobs.get('j1')!.doneBlock).toBe(chain.head - 2);
    expect(store.trades.size).toBe(1);
  });

  it('deletes trades older than the retention period, a slice at a time', async () => {
    const store = new InMemoryMiStore();
    const nowMs = 1_800_000_000_000;
    const t = (id: string, daysAgo: number) => ({ chain: 'bnb' as const, pool: '0xp', id, block: 1, blockHash: '0x', time: Math.floor(nowMs / 1000) - daysAgo * 86_400, side: 'buy' as const, baseAmount: '1', quoteAmount: '1', price: '1', maker: 'm' });
    await store.putTrades('a', [t('old', 40), t('mid', 20), t('new', 1)]);
    const chain = new FakeChain();
    chain.mineEmpty(3);
    const r = await runAll({ env: { MI_ADAPTERS: '' }, store, now: () => nowMs, budgetMs: 10_000, readFor: () => chain.read });
    expect(r.pruned).toBe(1);
    expect([...store.trades.values()].map((x) => x.id).sort()).toEqual(['mid', 'new']);
    const short = await runAll({ env: { MI_ADAPTERS: '', MI_TRADE_RETENTION_DAYS: '10' }, store, now: () => nowMs, budgetMs: 10_000, readFor: () => chain.read });
    expect(short.pruned).toBe(1);
    expect(store.trades.size).toBe(1);
  });

  it('a disabled adapter is skipped by the scheduled run', async () => {
    const chain = new FakeChain();
    chain.mineEmpty(5);
    const store = new InMemoryMiStore();
    await store.setAdapterDisabled(spec.id, true, 'maintenance', 1);
    const r = await runAll({ env: { MI_ADAPTERS: spec.id }, store, now: () => 1_700_000_100_000, budgetMs: 10_000, readFor: () => chain.read });
    expect(r.adapters[0]!.skipped).toBe('disabled');
  });
});
