import { describe, expect, it } from 'vitest';
import { changeBps, formatUnits, parseRaw, priceString, scaledToString, stringToScaled } from './math.js';

describe('decimal-safe maths', () => {
  it('prices a swap exactly with different decimals', () => {
    // 1.5 WETH (18 dec) bought for 3000 USDC (6 dec) -> 2000 USDC per WETH
    expect(priceString(1_500_000_000_000_000_000n, 18, 3_000_000_000n, 6)).toBe('2000');
    // 1,000,000 tokens (9 dec) for 0.5 native (18 dec) -> 0.0000005
    expect(priceString(1_000_000_000_000_000n, 9, 500_000_000_000_000_000n, 18)).toBe('0.0000005');
  });
  it('keeps precision beyond 2^53 and for tiny prices', () => {
    const p = priceString(123_456_789_012_345_678_901_234_567n, 18, 1n, 18)!;
    expect(p.startsWith('0.00000000')).toBe(true);
    expect(stringToScaled(p)).toBeGreaterThan(0n);
    expect(priceString(10n ** 30n, 18, 10n ** 18n, 18)).toBe('0.000000000001');
  });
  it('rejects zero amounts', () => {
    expect(priceString(0n, 18, 1n, 18)).toBeNull();
    expect(priceString(1n, 18, 0n, 18)).toBeNull();
  });
  it('round-trips the string form', () => {
    for (const v of ['0', '1', '12.5', '0.000001', '123456789.123456789']) expect(scaledToString(stringToScaled(v)!)).toBe(v);
    expect(stringToScaled('1e5')).toBeNull();
    expect(stringToScaled('abc')).toBeNull();
  });
  it('formats units and parses raw amounts strictly', () => {
    expect(formatUnits(1_234_500n, 6)).toBe('1.2345');
    expect(parseRaw('123')).toBe(123n);
    expect(parseRaw('-1')).toBeNull();
    expect(parseRaw('1.5')).toBeNull();
    expect(parseRaw(5)).toBeNull();
  });
  it('computes change in basis points without floats', () => {
    expect(changeBps('100', '110')).toBe(1000);
    expect(changeBps('100', '50')).toBe(-5000);
    expect(changeBps('0.000001', '0.000002')).toBe(10000);
    expect(changeBps('0', '1')).toBeNull();
    expect(changeBps(null, '1')).toBeNull();
  });
});
