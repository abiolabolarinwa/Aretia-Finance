import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MarketRow } from '../swings/market/types';
import { BOARD_CHAINS, BOARD_PAGE_SIZE, columnRows, pickFourth, pillChange, pillText } from './walletMarketBoard';

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

describe('the price-change pill', () => {
  const ch = (o: Partial<MarketRow['change']>): MarketRow['change'] => ({ m5: null, h1: null, h6: null, h24: null, ...o });
  it('shows the hour, then the 5-minute, 6-hour and 24-hour change, whichever is available first', () => {
    expect(pillChange(ch({ h1: 2, m5: 1, h6: 3, h24: 4 })).label).toBe('1H');
    expect(pillChange(ch({ m5: 1, h6: 3, h24: 4 })).label).toBe('5M');
    expect(pillChange(ch({ h6: 3, h24: 4 })).label).toBe('6H');
    expect(pillChange(ch({ h24: -4 }))).toEqual({ key: 'h24', label: '24H', value: -4 });
    expect(pillChange(ch({})).value).toBeNull();
  });
  it('says the window when it is not the hour, with an arrow for up or down', () => {
    expect(pillText({ label: '1H', value: 1.5 })).toBe('▲ 1.50%');
    expect(pillText({ label: '6H', value: -2 })).toBe('6H ▼ 2.00%');
    expect(pillText({ label: '24H', value: 0 })).toBe('24H 0.00%');
    expect(pillText({ label: '1H', value: null })).toBe('–');
  });
});

describe('a column scrolls by itself', () => {
  it('tells the page scroller (Lenis) to leave each column to the mouse wheel', () => {
    const code = readFileSync(new URL('./walletMarketBoard.ts', import.meta.url), 'utf8');
    expect(code).toContain("list.setAttribute('data-lenis-prevent', '')");
  });
});
