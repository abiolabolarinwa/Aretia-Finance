import { describe, expect, it } from 'vitest';
import { highDemand, modeNote, modeRows } from './marketModes';
import type { MarketRow } from './types';

const row = (symbol: string, o: { vol?: number; tx?: number; ch?: [number, number, number, number] }): MarketRow => {
  const w = (v: number | undefined) => ({ m5: v ?? null, h1: v ?? null, h6: v ?? null, h24: v ?? null });
  const ch = o.ch ?? [0, 0, 0, 0];
  return {
    chain: 'solana', address: symbol, symbol, quoteSymbol: 'SOL', name: symbol, icon: null, decimals: 9, pool: symbol, priceUsd: 1, capUsd: null, ageMs: 1000,
    txns24h: o.tx ?? null, volume24hUsd: o.vol ?? null, traders24h: null, change: { m5: ch[0], h1: ch[1], h6: ch[2], h24: ch[3] }, liquidityUsd: 1000, risk: null, fresh: false,
    volumeUsd: w(o.vol), txns: w(o.tx),
  } as MarketRow;
};

describe('Markets tabs', () => {
  const rows = [
    row('QUIET', { vol: 100, tx: 2, ch: [50, 50, 50, 50] }),
    row('BUSY', { vol: 90_000, tx: 900, ch: [0, 1, 2, 3] }),
    row('BUSIER', { vol: 400_000, tx: 4000, ch: [1, 5, 8, 12] }),
    row('RUNNER', { vol: 50_000, tx: 500, ch: [5, 20, 40, 80] }),
    row('SPIKE', { vol: 60_000, tx: 600, ch: [30, -5, 2, 10] }),
  ];

  it('Trending keeps only high demand, busiest first', () => {
    expect(modeRows('trending', 'h24', rows).map((r) => r.symbol)).toEqual(['BUSIER', 'BUSY', 'SPIKE', 'RUNNER']);
  });

  it('Top keeps only significant gains in the chosen window, biggest first', () => {
    expect(modeRows('top', 'h24', rows).map((r) => r.symbol)).toEqual(['RUNNER']);
    expect(modeRows('top', 'm5', rows).map((r) => r.symbol)).toEqual(['SPIKE', 'RUNNER']);
  });

  it('Gainers needs a gain in every window at once', () => {
    expect(modeRows('gainers', 'h24', rows).map((r) => r.symbol)).toEqual(['RUNNER', 'BUSIER']);
  });

  it('a token with no figure for a window is left out of it, not guessed at', () => {
    const noWindow = { ...row('NOWIN', { vol: 90_000, tx: 900 }), volumeUsd: undefined, txns: undefined } as MarketRow;
    expect(highDemand(noWindow, 'm5')).toBe(false);
    expect(highDemand(noWindow, 'h24')).toBe(true);
  });

  it('says the rule in words', () => {
    expect(modeNote('trending', 'm5')).toMatch(/high demand.*5M/);
    expect(modeNote('gainers', 'h1')).toMatch(/every window/);
  });
});
