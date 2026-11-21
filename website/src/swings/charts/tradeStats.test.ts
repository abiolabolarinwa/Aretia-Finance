import { describe, expect, it } from 'vitest';
import { buySellSplit, sizeHistogram, timeHistogram, topTraders, valueBasis } from './tradeStats';
import type { Trade } from './trades';

const T0 = Date.UTC(2026, 10, 21, 12, 0, 0);
const trade = (over: Partial<Trade>): Trade => ({ t: T0, kind: 'buy', usd: 10, tokenAmount: 1, quoteAmount: 0.1, priceUsd: 10, trader: 'A', tx: 'x', ...over });

describe('valueBasis', () => {
  it('uses dollars when most trades have a dollar value, otherwise the quote amount', () => {
    expect(valueBasis([trade({}), trade({}), trade({ usd: 0 })])).toBe('usd');
    expect(valueBasis([trade({ usd: 0 }), trade({ usd: 0 }), trade({})])).toBe('quote');
    expect(valueBasis([])).toBe('quote');
  });
});

describe('buySellSplit', () => {
  it('counts and sums each side and gives the buys\' share of the value', () => {
    const s = buySellSplit([trade({ usd: 30 }), trade({ usd: 10, kind: 'sell' }), trade({ usd: 10, kind: 'sell' })], 'usd');
    expect(s.buys).toEqual({ n: 1, value: 30 });
    expect(s.sells).toEqual({ n: 2, value: 20 });
    expect(s.buyShare).toBe(60);
  });
  it('falls back on the count when there is no value, and on an even split when there is nothing', () => {
    expect(buySellSplit([trade({ usd: 0 }), trade({ usd: 0, kind: 'sell' }), trade({ usd: 0, kind: 'sell' })], 'usd').buyShare).toBeCloseTo(33.33, 1);
    expect(buySellSplit([], 'usd').buyShare).toBe(50);
  });
});

describe('sizeHistogram', () => {
  it('spreads trades over buckets that grow by a constant factor, every trade in one bucket', () => {
    const trades = [1, 2, 4, 8, 100, 100, 1000].map((usd, i) => trade({ usd, kind: i % 2 ? 'sell' : 'buy' }));
    const bars = sizeHistogram(trades, 'usd', 4);
    expect(bars).toHaveLength(4);
    expect(bars.reduce((a, b) => a + b.buys + b.sells, 0)).toBe(7);
    expect(bars[0]!.lo).toBe(1);
    expect(bars[3]!.hi).toBeCloseTo(1000, 6);
    expect(bars[3]!.buys + bars[3]!.sells).toBeGreaterThan(0);
  });
  it('handles one size, and nothing', () => {
    expect(sizeHistogram([trade({ usd: 5 }), trade({ usd: 5, kind: 'sell' })], 'usd')).toEqual([{ lo: 5, hi: 5, buys: 1, sells: 1 }]);
    expect(sizeHistogram([], 'usd')).toEqual([]);
    expect(sizeHistogram([trade({ usd: 0 })], 'usd')).toEqual([]);
  });
});

describe('timeHistogram', () => {
  it('uses one-minute buckets for a short span and keeps the empty ones between', () => {
    const bars = timeHistogram([trade({ t: T0, usd: 5 }), trade({ t: T0 + 3 * 60_000, usd: 7, kind: 'sell' })], 'usd');
    expect(bars.map((b) => b.seconds)).toEqual([60, 60, 60, 60]);
    expect(bars.map((b) => b.n)).toEqual([1, 0, 0, 1]);
    expect(bars[0]!.buys).toBe(5);
    expect(bars[3]!.sells).toBe(7);
  });
  it('widens the buckets for a long span so the chart stays near 24 columns', () => {
    const bars = timeHistogram([trade({ t: T0 }), trade({ t: T0 + 20 * 3_600_000 })], 'usd');
    expect(bars[0]!.seconds).toBe(3600);
    expect(bars.length).toBeLessThanOrEqual(25);
    expect(timeHistogram([], 'usd')).toEqual([]);
  });
});

describe('topTraders', () => {
  it('ranks wallets by traded value, with the rest together and shares that add to 100', () => {
    const trades = ['A', 'A', 'B', 'C', 'D', 'E', 'F', 'G'].map((trader, i) => trade({ trader, usd: i === 0 ? 50 : 10 }));
    const got = topTraders(trades, 'usd', 3);
    expect(got.map((x) => x.trader)).toEqual(['A', 'B', 'C', '']);
    expect(got[0]!.value).toBe(60);
    expect(got.reduce((a, x) => a + x.share, 0)).toBeCloseTo(100, 6);
    expect(got[3]!.n).toBe(4);
  });
  it('gives nothing when no trade has a value', () => {
    expect(topTraders([trade({ usd: 0 })], 'usd')).toEqual([]);
  });
});
