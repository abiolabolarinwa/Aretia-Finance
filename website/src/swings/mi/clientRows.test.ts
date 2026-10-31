import { describe, expect, it } from 'vitest';
import { fetchNativeList, trackMarket, NATIVE_MIN_ROWS, fetchIndexedRows, fetchIndexedTrades, marketRowsFromPools, tradesFromIndexed } from './clientRows.js';
import { formatTradeUsd } from '../charts/trades.js';

const pool = (over: Record<string, unknown> = {}) => ({
  id: 'bnb:0xp', chain: 'bnb', address: '0x' + 'c3'.repeat(20), dex: 'pancakeswap', dexName: 'PancakeSwap V2', kind: 'v2', feeTier: null, state: 'active', stateReason: '',
  createdAt: new Date(1_000_000).toISOString(), ageSeconds: 5,
  base: { address: '0x' + 'a1'.repeat(20), symbol: 'MEME', name: 'Meme', decimals: 18, launchbox: null, nameFlags: [] },
  quote: { address: '0x' + 'b2'.repeat(20), symbol: 'USDT', name: 'Tether', decimals: 18, launchbox: null, nameFlags: [] },
  price: { quote: '0.1', usd: 0.1 }, changePct: { m5: 1.5, h1: null, h6: null, h24: -3 }, volume: { quote: null, usd: { m5: 1, h1: 2, h6: 3, h24: 4 } },
  txns: { buys: { m5: 0, h1: 1, h6: 2, h24: 3 }, sells: { m5: 0, h1: 1, h6: 2, h24: 4 } }, liquidity: { quote: 10, usd: 1000 }, quoteIsDollar: true, evidence: 'live-verified', links: { swap: '' }, ...over,
});

describe('Aretia Index rows for the existing tables', () => {
  it('maps a pool to a market row without inventing anything', () => {
    const [r] = marketRowsFromPools([pool(), pool({ address: 'not-an-address' }), null, 'x'], 1_060_000);
    expect(r).toMatchObject({ chain: 'bnb', symbol: 'MEME', quoteSymbol: 'USDT', pool: '0x' + 'c3'.repeat(20), priceUsd: 0.1, ageMs: 60_000, txns24h: 7, volume24hUsd: 4, liquidityUsd: 1000, traders24h: null, capUsd: null, risk: null });
    expect(r!.change).toEqual({ m5: 1.5, h1: null, h6: null, h24: -3 });
    expect(r!.indexed).toEqual({ quoteIsDollar: true, evidence: 'live-verified' });
    expect(marketRowsFromPools('nope', 1)).toEqual([]);
  });

  it('accepts Solana pools and signatures as they are written (case kept)', () => {
    const mint = 'So11111111111111111111111111111111111111112';
    const pool58 = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
    const [r] = marketRowsFromPools([pool({ chain: 'solana', address: pool58, base: { address: mint, symbol: 'X', name: '', decimals: 9, launchbox: null, nameFlags: [] } })], 1_060_000);
    expect([r!.chain, r!.pool, r!.address]).toEqual(['solana', pool58, mint]);
    const sig = '5'.repeat(88);
    const t = tradesFromIndexed({ data: [{ id: sig, unix: 1_700_000_000, side: 'sell', price: '1', baseAmount: '1000000000', quoteAmount: '5000000', account: pool58 }], meta: { baseDecimals: 9, quoteDecimals: 6 } }, true);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ tx: sig, tokenAmount: 1, quoteAmount: 5, kind: 'sell' });
  });

  it('keeps unknown numbers null when a pool has no stats yet', () => {
    const [r] = marketRowsFromPools([pool({ price: { quote: null, usd: null }, volume: { quote: null, usd: null }, txns: { buys: null, sells: null }, liquidity: { quote: null, usd: null } })], 1_060_000);
    expect([r!.priceUsd, r!.volume24hUsd, r!.txns24h, r!.liquidityUsd]).toEqual([null, null, null, null]);
  });

  it('turns raw integer trades into table trades with exact units, dollars only for a dollar quote', () => {
    const tx = '0x' + 'ab'.repeat(32);
    const body = { data: [{ id: `${tx}:3`, unix: 1_700_000_000, side: 'buy', price: '0.1', baseAmount: '1234500000000000000000', quoteAmount: '123450000000000000000', account: '0x' + '11'.repeat(20) }, { id: 'bad', unix: 1, side: 'buy', price: '1', baseAmount: '1', quoteAmount: '1', account: '0x' + '11'.repeat(20) }], meta: { baseDecimals: 18, quoteDecimals: 18 } };
    const usd = tradesFromIndexed(body, true);
    expect(usd).toHaveLength(1);
    expect(usd[0]).toMatchObject({ t: 1_700_000_000_000, kind: 'buy', usd: 123.45, tokenAmount: 1234.5, quoteAmount: 123.45, priceUsd: 0.1, tx });
    const native = tradesFromIndexed(body, false);
    expect(Number.isNaN(native[0]!.usd)).toBe(true);
    expect(native[0]!.priceUsd).toBeNull();
    expect(formatTradeUsd(native[0]!.usd)).toBe('–');
    expect(tradesFromIndexed({ data: [] }, true)).toEqual([]);
  });

  it('asks only Aretia\'s own endpoints, and explains an unconfigured index', async () => {
    const urls: string[] = [];
    const ok = (async (u: string) => (urls.push(u), new Response(JSON.stringify({ data: { ranked: [pool()] } }), { status: 200 }))) as unknown as typeof fetch;
    expect((await fetchIndexedRows('trending', 'bnb', 1_060_000, ok))).toHaveLength(1);
    await fetchIndexedTrades('bnb', '0x' + 'c3'.repeat(20), true, ok).catch(() => undefined);
    expect(urls.every((u) => u.startsWith('/api/v1/'))).toBe(true);
    const down = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    await expect(fetchIndexedRows('new', '', 1, down)).rejects.toThrow(/not set up/);
  });

  it('uses the index as a list only when it holds enough markets, else falls back (null)', async () => {
    const make = (n: number) => (async (u: string) => new Response(JSON.stringify({ data: u.includes('trending') ? { ranked: Array.from({ length: n }, () => pool()) } : Array.from({ length: n }, () => pool()) }), { status: 200 })) as unknown as typeof fetch;
    expect(await fetchNativeList('top', 'bnb', 'h24', 1_060_000, make(NATIVE_MIN_ROWS))).toHaveLength(NATIVE_MIN_ROWS);
    expect(await fetchNativeList('trending', '', 'h24', 1_060_000, make(NATIVE_MIN_ROWS))).toHaveLength(NATIVE_MIN_ROWS);
    expect(await fetchNativeList('top', 'bnb', 'h24', 1_060_000, make(NATIVE_MIN_ROWS - 1))).toBeNull();
    const down = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    expect(await fetchNativeList('new', 'bnb', 'h24', 1, down)).toBeNull();
    const boom = (async () => { throw new Error('x'); }) as unknown as typeof fetch;
    expect(await fetchNativeList('gainers', '', 'h1', 1, boom)).toBeNull();
  });

  it('asks the index to track a market it does not follow, once, and never for an indexed one', () => {
    const calls: { u: string; body: string }[] = [];
    const f = (async (u: string, init: RequestInit) => (calls.push({ u, body: String(init.body) }), new Response('{}'))) as unknown as typeof fetch;
    trackMarket({ chain: 'bnb', pool: '0xaa', indexed: undefined }, f);
    trackMarket({ chain: 'bnb', pool: '0xaa', indexed: undefined }, f);
    trackMarket({ chain: 'bnb', pool: '0xbb', indexed: { quoteIsDollar: true, evidence: 'x' } }, f);
    trackMarket({ chain: 'bnb', pool: '', indexed: undefined }, f);
    expect(calls).toEqual([{ u: '/api/v1/track', body: JSON.stringify({ chain: 'bnb', pool: '0xaa' }) }]);
  });
});
