import { describe, expect, it } from 'vitest';
import { isDeadMarket } from './dead';

const change = (m5: number | null, h1: number | null, h6: number | null, h24: number | null) => ({ change: { m5, h1, h6, h24 } });

describe('isDeadMarket', () => {
  it('is true when the hour, six hours and day are all down 100%, whatever the five minutes say', () => {
    expect(isDeadMarket(change(0, -100, -100, -100))).toBe(true);
    expect(isDeadMarket(change(-100, -100, -100, -100))).toBe(true);
    expect(isDeadMarket(change(null, -99.9, -100, -99.99))).toBe(true);
  });

  it('is false for a token that has lost a lot but still trades', () => {
    expect(isDeadMarket(change(0, -100, -100, -80))).toBe(false);
    expect(isDeadMarket(change(0, -50, -90, -99.99))).toBe(false);
    expect(isDeadMarket(change(0, 0, -100, -100))).toBe(false);
  });

  it('never hides a row with missing numbers', () => {
    expect(isDeadMarket(change(0, null, -100, -100))).toBe(false);
    expect(isDeadMarket(change(null, null, null, null))).toBe(false);
  });
});
