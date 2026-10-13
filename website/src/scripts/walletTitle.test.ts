import { describe, expect, it } from 'vitest';
import { titlePrice, tokenTitle } from './walletTitle.js';

describe('tab title', () => {
  it('writes prices in plain digits', () => {
    expect(titlePrice(0.0003613)).toBe('$0.0003613');
    expect(titlePrice(0.00000091234)).toBe('$0.0000009123');
    expect(titlePrice(0.2086)).toBe('$0.2086');
    expect(titlePrice(1.5)).toBe('$1.5');
    expect(titlePrice(168.4321)).toBe('$168.43');
    expect(titlePrice(64_250.7)).toBe('$64,251');
    for (const bad of [null, 0, -1, Number.NaN]) expect(titlePrice(bad as number | null)).toBe('');
  });
  it('names the token, its pair, network and venue', () => {
    expect(tokenTitle({ symbol: 'Frank', name: 'Frank Ashford', quoteSymbol: 'SOL', chainName: 'Solana', dex: 'pumpswap', priceUsd: 0.0003613 })).toBe('Frank $0.0003613 - Frank Ashford / SOL on Solana / Pumpswap - Aretia Finance');
    expect(tokenTitle({ symbol: 'X', name: '', quoteSymbol: '', chainName: 'Base', dex: null, priceUsd: null })).toBe('X - X on Base - Aretia Finance');
  });
  it('drops control characters and caps long names', () => {
    const t = tokenTitle({ symbol: 'A\u0000B', name: 'n'.repeat(100), quoteSymbol: 'ETH', chainName: 'Base', dex: 'Uniswap', priceUsd: 1 });
    expect(t.startsWith('AB $1 - ')).toBe(true);
    expect(t.length).toBeLessThan(120);
  });
});
