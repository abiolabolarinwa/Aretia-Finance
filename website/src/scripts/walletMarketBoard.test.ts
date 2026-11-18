import { describe, expect, it } from 'vitest';
import type { MarketRow } from '../swings/market/types';
import { columnRows, loadBoardView, pickFourth, saveBoardView } from './walletMarketBoard';

const row = (chain: MarketRow['chain'], symbol: string, over: Partial<MarketRow> = {}): MarketRow =>
  ({ chain, address: `0x${symbol}`, symbol, quoteSymbol: 'X', name: symbol, icon: null, decimals: 18, pool: 'p', priceUsd: 1, capUsd: 100, ageMs: 1, txns24h: 1, volume24hUsd: 1, traders24h: 1, change: { m5: 0, h1: 1, h6: 0, h24: 0 }, liquidityUsd: 1, ...over }) as MarketRow;

describe('columnRows', () => {
  it('keeps one network, in order, with rows missing a price or a market cap last', () => {
    const rows = [row('solana', 'A', { capUsd: null }), row('bnb', 'B'), row('solana', 'C'), row('solana', 'D', { priceUsd: null }), row('solana', 'E')];
    expect(columnRows(rows, 'solana').map((r) => r.symbol)).toEqual(['C', 'E', 'A', 'D']);
    expect(columnRows(rows, 'ethereum')).toEqual([]);
  });
});

describe('pickFourth', () => {
  it('shows the chosen network, unless it is empty and the other has tokens', () => {
    expect(pickFourth([row('base', 'A')], 'base')).toBe('base');
    expect(pickFourth([row('robinhood', 'A')], 'base')).toBe('robinhood');
    expect(pickFourth([], 'base')).toBe('base');
    expect(pickFourth([row('base', 'A'), row('robinhood', 'B')], 'robinhood')).toBe('robinhood');
  });
});

describe('the remembered layout', () => {
  const store = () => {
    const s: Record<string, string> = {};
    return { getItem: (k: string) => s[k] ?? null, setItem: (k: string, v: string) => void (s[k] = v) };
  };
  it('is the board until the table is chosen, and survives missing or broken storage', () => {
    const s = store();
    expect(loadBoardView(s)).toBe('board');
    saveBoardView(s, 'table');
    expect(loadBoardView(s)).toBe('table');
    saveBoardView(s, 'board');
    expect(loadBoardView(s)).toBe('board');
    expect(loadBoardView(null)).toBe('board');
    expect(() => saveBoardView({ getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('full'); } }, 'table')).not.toThrow();
    expect(loadBoardView({ getItem: () => { throw new Error('x'); }, setItem: () => undefined })).toBe('board');
  });
});
