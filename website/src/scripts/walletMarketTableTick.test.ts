import { describe, expect, it } from 'vitest';
import { tickDirection } from './walletMarketTable';
import type { MarketRow } from '../swings/market/types';

const row = (priceUsd: number | null, h1: number | null, m5: number | null = 0): MarketRow => ({ priceUsd, change: { m5, h1, h6: 1, h24: 2 } }) as unknown as MarketRow;

describe('which live cells flash, and which way', () => {
  it('flashes the price green when it rose and red when it fell', () => {
    expect(tickDirection(1, row(2, 0), row(1, 0))).toBe('up');
    expect(tickDirection(1, row(1, 0), row(2, 0))).toBe('down');
    expect(tickDirection(1, row(1, 0), row(1, 0))).toBeNull();
  });
  it('flashes the 5M and 1H changes too, the same way', () => {
    expect(tickDirection(6, row(1, 12), row(1, 10))).toBe('up');
    expect(tickDirection(6, row(1, -3), row(1, 4))).toBe('down');
    expect(tickDirection(5, row(1, 0, 5), row(1, 0, 6))).toBe('down');
    expect(tickDirection(7, row(1, 0), row(1, 0))).toBeNull();
  });
  it('does not flash without something to compare with, or for other cells', () => {
    expect(tickDirection(1, row(2, 0), undefined)).toBeNull();
    expect(tickDirection(1, row(null, 0), row(1, 0))).toBeNull();
    expect(tickDirection(6, row(1, null), row(1, 3))).toBeNull();
    expect(tickDirection(0, row(2, 0), row(1, 0))).toBeNull();
    expect(tickDirection(3, row(2, 0), row(1, 0))).toBeNull();
  });
});
