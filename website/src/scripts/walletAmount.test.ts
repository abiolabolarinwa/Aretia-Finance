import { describe, expect, it } from 'vitest';
import { CHAINS } from '../swings/core/types.js';
import { cushionUnits, FEE_CUSHION, shareOfBalance } from './walletAmount.js';

describe('shareOfBalance', () => {
  it('takes a tenth, a half or all of a token balance, rounding down', () => {
    expect(shareOfBalance(1_000n, 10, null)).toBe(100n);
    expect(shareOfBalance(1_000n, 50, null)).toBe(500n);
    expect(shareOfBalance(1_000n, 100, null)).toBe(1_000n);
    expect(shareOfBalance(7n, 50, null)).toBe(3n);
    expect(shareOfBalance(9n, 10, null)).toBe(0n);
  });
  it('keeps a fee cushion back when spending the native coin', () => {
    const cushion = 20n;
    expect(shareOfBalance(1_000n, 100, { cushion })).toBe(980n);
    expect(shareOfBalance(1_000n, 50, { cushion })).toBe(500n);
    // A half that would dip into the cushion is cut back to what can be spent.
    expect(shareOfBalance(30n, 50, { cushion })).toBe(10n);
  });
  it('is zero when there is nothing to spend, never negative', () => {
    expect(shareOfBalance(0n, 100, null)).toBe(0n);
    expect(shareOfBalance(5n, 100, { cushion: 20n })).toBe(0n);
    expect(shareOfBalance(-5n, 50, null)).toBe(0n);
  });
  it('never exceeds the balance', () => {
    for (const bal of [1n, 99n, 123_456_789_012_345_678_901n]) for (const pct of [10, 50, 100] as const) expect(shareOfBalance(bal, pct, null) <= bal).toBe(true);
  });
});

describe('fee cushion', () => {
  it('turns coins into the smallest unit exactly', () => {
    expect(cushionUnits('0.0005', 18)).toBe(500_000_000_000_000n);
    expect(cushionUnits('0.005', 9)).toBe(5_000_000n);
    expect(cushionUnits('1', 6)).toBe(1_000_000n);
  });
  it('has an entry for every network, and none that rounds away at that network’s decimals', () => {
    for (const [id, coins] of Object.entries(FEE_CUSHION)) {
      const c = CHAINS[id as keyof typeof CHAINS];
      expect(c, id).toBeTruthy();
      expect(cushionUnits(coins, c.nativeDecimals) > 0n, id).toBe(true);
    }
    for (const id of Object.keys(CHAINS)) expect(FEE_CUSHION, id).toHaveProperty(id);
  });
});
