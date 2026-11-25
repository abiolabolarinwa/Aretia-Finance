import { describe, expect, it } from 'vitest';
import { canAfford, loadSlippage, quickAmountsFor, saveSlippage } from './walletQuickTrade';

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

describe('one-tap amounts', () => {
  it('offers round amounts of each network coin and of dollar stablecoins, and nothing for other tokens', () => {
    expect(quickAmountsFor('solana', 'SOL', true)).toEqual(['0.1', '0.5', '1']);
    expect(quickAmountsFor('polygon', 'POL', true)).toEqual(['10', '50', '100']);
    expect(quickAmountsFor('bnb', 'usdt', false)).toEqual(['10', '50', '100']);
    expect(quickAmountsFor('solana', 'BONK', false)).toEqual([]);
  });
  it('is blocked only when the balance is known and too small', () => {
    expect(canAfford('0.5', 9, 400_000_000n)).toBe(false);
    expect(canAfford('0.5', 9, 500_000_000n)).toBe(true);
    expect(canAfford('0.5', 9, null)).toBe(true);
  });
});

describe('the slippage chosen last time', () => {
  it('is kept and read back, only when it is one of the choices', () => {
    const s = memory();
    expect(loadSlippage(s)).toBeNull();
    saveSlippage(s, 100);
    expect(loadSlippage(s)).toBe(100);
    saveSlippage(s, 777);
    expect(loadSlippage(s)).toBe(100);
    s.setItem('aretia.swap.slippageBps', '999');
    expect(loadSlippage(s)).toBeNull();
  });
  it('survives blocked storage', () => {
    const blocked = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(loadSlippage(blocked)).toBeNull();
    expect(() => saveSlippage(blocked, 100)).not.toThrow();
    expect(loadSlippage(null)).toBeNull();
  });
});
