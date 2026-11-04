import { describe, expect, it } from 'vitest';
import { fetchNativeList, rankIndexRows } from './clientRows';
import type { MarketRow } from '../market/types';

const row = (n: number, o: Partial<MarketRow> = {}): MarketRow => ({
  chain: 'bnb', address: `0x${String(n).padStart(40, '0')}`, symbol: `T${n}`, quoteSymbol: 'WBNB', name: `Token ${n}`, icon: null, decimals: 18, pool: `0x${String(n).padStart(40, '1')}`,
  priceUsd: 1, capUsd: null, ageMs: n * 1000, txns24h: n, volume24hUsd: n * 10, traders24h: null, change: { m5: null, h1: null, h6: null, h24: n }, liquidityUsd: 5_000, risk: null, fresh: true, ...o,
});

describe('the index standing in for the outside feed', () => {
  const rows = [row(1), row(3, { txns24h: null, volume24hUsd: null }), row(2, { liquidityUsd: 10 })];
  it('ranks each tab by a number the index states, rows without it last', () => {
    expect(rankIndexRows('trending', 'h24', rows).map((r) => r.symbol)).toEqual(['T2', 'T1', 'T3']);
    expect(rankIndexRows('top', 'h24', rows).map((r) => r.symbol)).toEqual(['T2', 'T1', 'T3']);
    expect(rankIndexRows('new', 'h24', rows).map((r) => r.symbol)).toEqual(['T1', 'T2', 'T3']);
  });
  it('keeps Gainers to pools with real liquidity and never invents a missing change', () => {
    const g = rankIndexRows('gainers', 'h1', rows);
    expect(g.map((r) => r.symbol)).toEqual(['T1', 'T3']);
    expect(g[0]!.change.h1).toBeNull();
  });
  it('takes a small index list when asked to, and refuses it by default', async () => {
    const pool = (n: number) => ({ address: row(n).pool, chain: 'bnb', base: { address: row(n).address, symbol: 'A', name: 'A', decimals: 18 }, quote: { symbol: 'W' }, evidence: 'live-verified' });
    const f = (async () => new Response(JSON.stringify({ data: [pool(1), pool(2)] }))) as unknown as typeof fetch;
    expect(await fetchNativeList('new', 'bnb', 'h24', 0, f)).toBeNull();
    expect((await fetchNativeList('new', 'bnb', 'h24', 0, f, 1))?.length).toBe(2);
  });
});
