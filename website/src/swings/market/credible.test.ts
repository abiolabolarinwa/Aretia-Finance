import { describe, expect, it } from 'vitest';
import { dedupeBySymbol, isBeyondCredible } from './credible';
import { formatChange } from './types';

describe('credible changes', () => {
  it('treats a move beyond 1,000% as not credible, and a missing number as not beyond', () => {
    expect(isBeyondCredible(1000)).toBe(false);
    expect(isBeyondCredible(1000.1)).toBe(true);
    expect(isBeyondCredible(12_901)).toBe(true);
    expect(isBeyondCredible(null)).toBe(false);
  });
  it('prints such a move as >1,000%, not to the digit', () => {
    expect(formatChange(12_901)).toBe('>1,000%');
    expect(formatChange(1000)).toBe('1000.00%');
  });
});

describe('one symbol once per network', () => {
  const r = (chain: string, symbol: string, n: number) => ({ chain: chain as 'solana', symbol, n });
  it('keeps the first row of a symbol on a network and every other symbol', () => {
    const out = dedupeBySymbol([r('solana', 'USPR', 1), r('solana', 'AODF', 2), r('solana', 'uspr', 3), r('solana', 'AODF', 4), r('bnb', 'USPR', 5)]);
    expect(out.map((x) => x.n)).toEqual([1, 2, 5]);
  });
  it('never drops a row that has no symbol', () => {
    expect(dedupeBySymbol([r('solana', '', 1), r('solana', ' ', 2)]).map((x) => x.n)).toEqual([1, 2]);
  });
});

describe('Gainers', () => {
  it('does not rank a move beyond 1,000% (index stand-in)', async () => {
    const { rankIndexRows } = await import('../mi/clientRows');
    const row = (symbol: string, h24: number) => ({ chain: 'solana', symbol, liquidityUsd: 5000, change: { m5: 0, h1: 1, h6: 1, h24 } }) as never;
    const out = rankIndexRows('gainers', 'h24', [row('FAKE', 12_901), row('REAL', 80)]) as unknown as { symbol: string }[];
    expect(out.map((x) => x.symbol)).toEqual(['REAL']);
  });
});
