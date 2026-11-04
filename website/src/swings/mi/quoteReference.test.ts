import { describe, expect, it } from 'vitest';
import { convertRowsToUsd, findReferencePool, loadQuoteReference, MAX_REFERENCE_AGE_S, referencePriceAt } from './quoteReference.js';
import { InMemoryMiStore } from './store.js';
import { chainConfig } from './chains.js';
import type { MiPool, MiTrade } from './types.js';
import { miOhlcv } from '../../../api/_marketIndexer.js';

const cfg = chainConfig('base');
const WETH = cfg.quoteTokens.find((q) => q.symbol === 'WETH')!.address;
const USDC = cfg.quoteTokens.find((q) => q.symbol === 'USDC')!.address;
const TOKEN = '0xb6f3897a97ee1391b1ffbdfa485fbc452ba34480';
const SPACEX_POOL = '0xc42c64a0f871ea81787ac2dfa3709cf20c0aabaf';
const ETH_POOL = '0x' + 'e7'.repeat(20);
const T0 = 1_793_766_000;

const pool = (address: string, base: string, quote: string, over: Partial<MiPool> = {}): MiPool => ({
  key: `base:${address}`, chain: 'base', address, adapterId: 'uniswap-v2-base', dex: 'uniswap-v2', kind: 'v2', feeTier: null, base, quote,
  baseDecimals: 18, quoteDecimals: base === USDC || quote === USDC ? 6 : 18, baseIsToken0: true, baseVault: null, quoteVault: null, tickSpacing: null, hooks: null,
  historyBlock: null, historyDone: true, createdBlock: 1, createdTx: '0x1', createdAt: (T0 - 100_000) * 1000, state: 'active', stateReason: '', stateAt: 0,
  reserveBase: null, reserveBase2: undefined, reserveQuote: null, reserveBlock: null, firstTradeAt: null, lastTradeAt: null, paused: false, stats: null, ...over,
} as unknown as MiPool);

const trade = (p: string, i: number, time: number, price: string, quoteAmount: string): MiTrade => ({
  chain: 'base', pool: p, id: `0x${i.toString(16).padStart(64, '0')}:0`, block: 100 + i, blockHash: '0x0', time, side: 'buy',
  baseAmount: '1000000000000000000', quoteAmount, price, maker: '0x' + 'ab'.repeat(20),
});

async function seeded(opts: { refTrades?: boolean } = {}) {
  const store = new InMemoryMiStore();
  await store.insertPool(pool(SPACEX_POOL, TOKEN, WETH));
  await store.insertPool(pool(ETH_POOL, WETH, USDC, { stats: null }));
  // SPACEX trades priced in WETH: 1e-6 then 2e-6 WETH (18 decimals: 1 WETH = 1e18), in two 15-minute candles.
  await store.putTrades('uniswap-v2-base', [trade(SPACEX_POOL, 1, T0 + 60, '0.000001000000000000', '2000000000000'), trade(SPACEX_POOL, 2, T0 + 960, '0.000002000000000000', '4000000000000')]);
  // The reference pool: WETH in USDC, 2000 then 2100.
  if (opts.refTrades !== false) await store.putTrades('uniswap-v2-base', [trade(ETH_POOL, 3, T0 - 600, '2000.000000000000000000', '2000000000'), trade(ETH_POOL, 4, T0 + 900, '2100.000000000000000000', '2100000000')]);
  return store;
}

describe('the quote token reference price', () => {
  it('finds the most liquid pool that pairs the quote token with a dollar stablecoin, either way round', async () => {
    const store = await seeded();
    const ref = await findReferencePool(store, 'base', WETH);
    expect(ref?.pool.address).toBe(ETH_POOL);
    expect(ref?.inverted).toBe(false);
    expect(ref?.label).toBe('WETH / USDC');
    // No dollar pool for a token that has none.
    expect(await findReferencePool(store, 'base', TOKEN)).toBeNull();
  });

  it('prices a moment from the newest reference trade at or before it, never one that is too old, never one from the future', () => {
    const pts: [number, number][] = [[100, 2000], [200, 2100]];
    expect(referencePriceAt(pts, 99)).toBeNull();
    expect(referencePriceAt(pts, 150)).toBe(2000);
    expect(referencePriceAt(pts, 200)).toBe(2100);
    expect(referencePriceAt(pts, 200 + MAX_REFERENCE_AGE_S)).toBe(2100);
    expect(referencePriceAt(pts, 200 + MAX_REFERENCE_AGE_S + 1)).toBeNull();
    expect(referencePriceAt([], 5)).toBeNull();
  });

  it('converts candles with the price in force at the END of each candle, volume too, and drops a candle it cannot price', () => {
    const rows: [number, number, number, number, number, number][] = [[1000, 1e-6, 2e-6, 5e-7, 1e-6, 3], [2000, 2e-6, 2e-6, 2e-6, 2e-6, 1], [50, 1, 1, 1, 1, 1]];
    const out = convertRowsToUsd(rows, 900, [[1500, 2000], [2400, 2100]]);
    // The first candle ends at 1899: the 2000 reference. The second ends at 2899: 2100. The third has no reference before it.
    expect(out).toEqual([[1000, 1e-6 * 2000, 2e-6 * 2000, 5e-7 * 2000, 1e-6 * 2000, 3 * 2000], [2000, 2e-6 * 2100, 2e-6 * 2100, 2e-6 * 2100, 2e-6 * 2100, 2100]]);
  });

  it('reads reference trades from the index, and says nothing when there are none', async () => {
    const store = await seeded();
    const ref = await loadQuoteReference(store, 'base', WETH, T0, T0 + 1800);
    expect(ref?.label).toBe('WETH / USDC');
    expect(ref?.latest).toEqual({ price: 2100, at: T0 + 900 });
    expect(await loadQuoteReference(await seeded({ refTrades: false }), 'base', WETH, T0, T0 + 1800)).toBeNull();
  });
});

describe('dollar candles for a WETH-quoted pool (the chart asking the index)', () => {
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  const ask = (store: InMemoryMiStore, q: Record<string, string> = {}) =>
    miOhlcv({ query: { chain: 'base', pool: SPACEX_POOL, tf: 'minute', agg: '15', before: String(T0 + 1800), limit: '300', ...q }, env, fetchImpl: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch, now: (T0 + 1700) * 1000, ip: '4.4.4.4' }, store);

  it('converts with the time-aligned price and names the reference, instead of an empty list', async () => {
    const out = JSON.parse((await ask(await seeded())).body);
    expect(out.unit).toBe('usd-converted');
    expect(out.source).toBe('aretia-index');
    expect(out.reference).toMatchObject({ pool: ETH_POOL, label: 'WETH / USDC', price: 2100, at: T0 + 900 });
    const list: number[][] = out.data.attributes.ohlcv_list;
    expect(list).toHaveLength(2);
    // Newest first. The trade at T0+60 is in the candle starting T0 (aligned to 900 s), priced with the reference in force at that candle's end (2000, from T0-600).
    const first = list[1]!;
    expect(first[4]).toBeCloseTo(1e-6 * 2000, 12);
    expect(list[0]![4]).toBeCloseTo(2e-6 * 2100, 12);
  });

  it('answers in the quote token as before, and an empty dollar list without a reference (never an invented rate)', async () => {
    const store = await seeded();
    const token = JSON.parse((await ask(store, { currency: 'token' })).body);
    expect(token.unit).toBe('quote');
    expect(token.data.attributes.ohlcv_list).toHaveLength(2);
    const bare = JSON.parse((await ask(await seeded({ refTrades: false }))).body);
    expect(bare.data.attributes.ohlcv_list).toEqual([]);
    expect(bare.reference).toBeUndefined();
  });
});
