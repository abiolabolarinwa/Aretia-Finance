import { describe, expect, it } from 'vitest';
import { buyerGrowth, modeRows } from './marketModes';
import type { MarketRow } from './types';
import type { ChainId } from '../core/types';

const token = (symbol: string, chain: ChainId, buyers: [number, number, number, number] | null, liquidity = 50_000): MarketRow =>
  ({
    chain, address: symbol, symbol, quoteSymbol: 'SOL', name: symbol, icon: null, decimals: 9, pool: symbol, priceUsd: 1, capUsd: null, ageMs: 1000,
    txns24h: 900, volume24hUsd: 90_000, traders24h: null, change: { m5: 0, h1: 0, h6: 0, h24: 0 }, liquidityUsd: liquidity, risk: null, fresh: false,
    volumeUsd: { m5: 5_000, h1: 20_000, h6: 60_000, h24: 90_000 }, txns: { m5: 50, h1: 200, h6: 600, h24: 900 },
    ...(buyers ? { buyers: { m5: buyers[0], h1: buyers[1], h6: buyers[2], h24: buyers[3] } } : {}),
  }) as MarketRow;

describe('Rising: tokens whose buyers are growing', () => {
  it('measures how much faster buyers arrive now than before', () => {
    // 1H: 30 buyers in the last hour; 6H: 40 in total, so 10 in the earlier five hours.
    const g = buyerGrowth(token('A', 'solana', [5, 30, 40, 80]), 'h1');
    expect(g).toBeCloseTo(13.9, 0);
    expect(buyerGrowth(token('B', 'solana', null), 'h1')).toBeNull();
  });

  it('puts growing tokens first, fastest growth first, and keeps every other token after them', () => {
    const rows = [
      token('FLAT', 'solana', [5, 20, 120, 300]),
      token('FAST', 'solana', [10, 60, 70, 150]),
      token('SLOW', 'solana', [4, 24, 60, 200]),
      token('NODATA', 'solana', null),
      token('TINY', 'solana', [10, 60, 70, 150], 500),
    ];
    const out = modeRows('rising', 'h1', rows);
    expect(out.rows).toHaveLength(5);
    expect(out.rows.slice(0, out.count).map((r) => r.symbol)).toEqual(['FAST', 'SLOW']);
    expect(out.rows[out.rows.length - 1]!.symbol).toBe('NODATA');
  });

  it('leaves out a token whose pool is too small, however fast its buyers grow', () => {
    const out = modeRows('rising', 'h1', [token('TINY', 'solana', [10, 60, 70, 150], 500)]);
    expect(out.count).toBe(0);
  });

  it('takes each network in turn, so every network has its best at the top', () => {
    const grow = (n: number): [number, number, number, number] => [10, 60 + n, 70 + n, 150];
    const rows = [
      ...[5, 4, 3].map((n, i) => token(`S${i}`, 'solana', grow(n * 10))),
      ...[2, 1].map((n, i) => token(`B${i}`, 'bnb' as ChainId, grow(n))),
    ];
    const out = modeRows('rising', 'h1', rows).rows.map((r) => r.symbol);
    expect(out.slice(0, 4)).toEqual(['S0', 'B0', 'S1', 'B1']);
  });
});
