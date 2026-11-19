import { describe, expect, it } from 'vitest';
import type { MarketRow } from '../swings/market/types';
import { BOARD_CHAINS, BOARD_PAGE_SIZE, columnRows, pickFourth } from './walletMarketBoard';

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

describe('what the board asks for', () => {
  it('reads every network on its own, 100 tokens a page', () => {
    expect([...BOARD_CHAINS]).toEqual(['solana', 'ethereum', 'bnb', 'base', 'robinhood']);
    expect(BOARD_PAGE_SIZE).toBe(100);
  });
});
