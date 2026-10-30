import { describe, expect, it } from 'vitest';
import { risingStrip } from './walletDashRising';
import type { MarketRow } from '../swings/market/types';

const row = (symbol: string, chain: string, liquidity = 50_000): MarketRow =>
  ({
    chain, address: chain === 'solana' ? `${symbol}1111111111111111111111111111111111` : '0x' + '1'.repeat(40), symbol, quoteSymbol: 'SOL', name: symbol, icon: null, decimals: 9, pool: symbol,
    priceUsd: 0.01, capUsd: 120_000, ageMs: 1000, txns24h: 900, volume24hUsd: 90_000, traders24h: null, change: { m5: 0, h1: 0, h6: 0, h24: 0 }, liquidityUsd: liquidity, risk: null, fresh: false,
    volumeUsd: { m5: 5_000, h1: 20_000, h6: 60_000, h24: 90_000 }, txns: { m5: 50, h1: 200, h6: 600, h24: 900 },
    buyers: { m5: 10, h1: 60, h6: 70, h24: 150 },
  }) as MarketRow;

describe('the dashboard Rising strip', () => {
  it('lists only tokens that clear the Rising bar, at most ten', () => {
    const rows = Array.from({ length: 14 }, (_, i) => row(`T${i}`, i % 2 ? 'bnb' : 'solana'));
    expect(risingStrip(rows)).toHaveLength(10);
    expect(risingStrip([row('SMALL', 'solana', 100)])).toEqual([]);
  });

  it('gives every network a place among the ten before any network gets a second', () => {
    const rows = [row('S1', 'solana'), row('S2', 'solana'), row('B1', 'bnb')];
    const first = risingStrip(rows).slice(0, 2).map((x) => x.row.chain);
    expect(new Set(first)).toEqual(new Set(['solana', 'bnb']));
  });

  it('reports how much faster buyers arrive', () => {
    expect(risingStrip([row('GROW', 'solana')])[0]!.growth).toBeGreaterThan(1.5);
  });
});
