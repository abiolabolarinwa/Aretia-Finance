import { beforeEach, describe, expect, it } from 'vitest';
import { clearsMinLiquidity, DEFAULT_MIN_LIQUIDITY, loadMinLiquidity, resetMinLiquidityMemory, saveMinLiquidity } from './walletMinLiquidity';

const store = () => {
  const s: Record<string, string> = {};
  return { s, getItem: (k: string) => s[k] ?? null, setItem: (k: string, v: string) => void (s[k] = v), removeItem: () => undefined };
};

describe('the minimum liquidity of the Markets lists', () => {
  beforeEach(resetMinLiquidityMemory);
  it('defaults to $1,000 and remembers a choice, including Any liquidity', () => {
    const st = store();
    expect(loadMinLiquidity(st)).toBe(DEFAULT_MIN_LIQUIDITY);
    saveMinLiquidity(st, '0');
    resetMinLiquidityMemory();
    expect(loadMinLiquidity(st)).toBe('0');
  });
  it('ignores a stored value that is not one of the choices', () => {
    const st = store();
    st.setItem('aretia-market-min-liquidity-v1', '5');
    expect(loadMinLiquidity(st)).toBe('1000');
  });
  it('keeps the choice in memory when the browser will not store it', () => {
    const broken = {
      getItem: () => {
        throw new Error('no');
      },
      setItem: () => {
        throw new Error('no');
      },
      removeItem: () => undefined,
    };
    expect(loadMinLiquidity(broken)).toBe('1000');
    saveMinLiquidity(broken, '10000');
    expect(loadMinLiquidity(broken)).toBe('10000');
    expect(loadMinLiquidity(null)).toBe('10000');
  });
  it('counts unknown liquidity as below the minimum, except under Any liquidity', () => {
    expect(clearsMinLiquidity(null, '1000')).toBe(false);
    expect(clearsMinLiquidity(999, '1000')).toBe(false);
    expect(clearsMinLiquidity(1000, '1000')).toBe(true);
    expect(clearsMinLiquidity(null, '0')).toBe(true);
  });
});
