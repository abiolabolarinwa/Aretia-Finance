// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { MarketRow } from '../swings/market/types';
import { marketBoard, withPriceFirst } from './walletMarketBoard';

const row = (chain: MarketRow['chain'], symbol: string, over: Partial<MarketRow> = {}): MarketRow =>
  ({ chain, address: `0x${symbol}`, symbol, quoteSymbol: 'X', name: symbol, icon: null, decimals: 18, pool: 'p', priceUsd: 1, capUsd: 100, ageMs: 1, txns24h: 1, volume24hUsd: 1, traders24h: 1, change: { m5: null, h1: 1, h6: null, h24: null }, liquidityUsd: 1, ...over }) as unknown as MarketRow;

const rows = [row('solana', 'A'), row('bnb', 'B'), row('ethereum', 'C', { capUsd: null }), row('solana', 'D')];
const base = { rows, fourth: 'base' as const, onFourth: () => undefined, onOpen: () => undefined };
const symbols = (board: HTMLElement): string[] => [...board.querySelectorAll('.wapp-bd__sym')].map((s) => s.textContent ?? '');

describe('the phone board', () => {
  it('shows every network together under the Aretia mark when no network is picked', () => {
    const board = marketBoard({ ...base, single: 'all', listKey: 'all-test' });
    expect(board.querySelectorAll('.wapp-bd__col')).toHaveLength(1);
    expect(board.querySelector('.wapp-bd__title')!.textContent).toBe('All networks');
    expect(board.querySelector<HTMLImageElement>('.wapp-bd__chain')!.getAttribute('src')).toBe('/assets/logo-mark.png');
    expect(symbols(board)).toEqual(['A', 'B', 'D', 'C']);
  });
  it('shows only the picked network', () => {
    const board = marketBoard({ ...base, single: 'solana', listKey: 'sol-test' });
    expect(board.querySelectorAll('.wapp-bd__col')).toHaveLength(1);
    expect(board.querySelector('.wapp-bd__title')!.textContent).toBe('Solana');
    expect(symbols(board)).toEqual(['A', 'D']);
  });
  it('keeps the four columns when not on a phone', () => {
    expect(marketBoard({ ...base, listKey: 'wide-test' }).querySelectorAll('.wapp-bd__col')).toHaveLength(4);
  });
  it('lists rows with a price and a market cap first', () => {
    expect(withPriceFirst(rows).map((r) => r.symbol)).toEqual(['A', 'B', 'D', 'C']);
  });
});
