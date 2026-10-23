import { describe, expect, it } from 'vitest';
import { buildCandleRows, computeStats, trendingScore } from './stats.js';
import type { MiTrade } from './types.js';

const mk = (i: number, time: number, price: string, quote: bigint, side: 'buy' | 'sell' = 'buy', maker = 'm' + i): MiTrade => ({ chain: 'bnb', pool: '0xp', id: `0x${i}:0`, block: i, blockHash: '0x', time, side, baseAmount: '1', quoteAmount: quote.toString(), price, maker });

describe('stats', () => {
  const now = 100_000_000;
  const nowSec = now / 1000;
  it('returns null with no trades', () => expect(computeStats({ quoteDecimals: 6 }, [], null, now, { quoteUsd: 1 }, null)).toBeNull());

  it('computes windowed volume, counts and change from integers', () => {
    const trades = [mk(1, nowSec - 20_000, '1', 1_000_000n), mk(2, nowSec - 4_000, '1.1', 2_000_000n, 'sell'), mk(3, nowSec - 100, '1.21', 3_000_000n)];
    const s = computeStats({ quoteDecimals: 6 }, trades, null, now, { quoteUsd: 1 }, 50_000_000n)!;
    expect(s.price).toBe('1.21');
    expect(s.volumeQuote).toEqual({ m5: 3, h1: 3, h6: 6, h24: 6 });
    expect(s.buys.h24).toBe(2);
    expect(s.sells.h24).toBe(1);
    expect(s.change.m5).toBe(1000); // opened at 1.1 (last trade at or before the window start), now 1.21
    expect(s.change.h24).toBe(2100); // first trade 1 -> 1.21
    expect(s.liquidityUsd).toBe(100);
    expect(s.maxTradeShare24h).toBe(0.5);
    expect(s.makers24h).toBe(3);
  });
  it('states no USD when the quote has no known dollar value', () => {
    const s = computeStats({ quoteDecimals: 18 }, [mk(1, nowSec - 10, '2', 5n * 10n ** 18n), mk(2, nowSec - 5, '3', 10n ** 18n)], null, now, { quoteUsd: null }, null)!;
    expect(s.priceUsd).toBeNull();
    expect(s.volumeUsd.h24).toBeNull();
    expect(s.liquidityUsd).toBeNull();
  });
  it('a single trade has no change', () => {
    expect(computeStats({ quoteDecimals: 6 }, [mk(1, nowSec - 10, '2', 1n)], null, now, { quoteUsd: 1 }, null)!.change.h24).toBeNull();
  });
  it('builds candles without inventing gaps, independent of arrival order', () => {
    const t = [mk(1, 1000, '2', 10n), mk(2, 1030, '3', 10n), mk(3, 1050, '1', 10n), mk(4, 1200, '5', 10n)];
    const a = buildCandleRows(t, 60, 0);
    expect(buildCandleRows([...t].reverse(), 60, 0)).toEqual(a);
    // 1000 is in minute 960; 1030 and 1050 in minute 1020; 1200 in minute 1200 (the empty minutes between get no candle)
    expect(a.map((r) => r[0])).toEqual([960, 1020, 1200]);
    expect(a[1]).toEqual([1020, 3, 3, 1, 1, 20]);
  });
  it('trending ranks real two-sided activity and ignores thin, young or one-sided pools', () => {
    const trades = Array.from({ length: 30 }, (_, i) => mk(i, nowSec - 100 - i * 60, '1', 1_000_000_000n, i % 2 ? 'buy' : 'sell'));
    const base = computeStats({ quoteDecimals: 6 }, trades, null, now, { quoteUsd: 1 }, 100_000_000_000n)!;
    const created = now - 3_600_000;
    const good = trendingScore({ stats: base, createdAt: created, now })!;
    expect(good).toBeGreaterThan(0);
    expect(trendingScore({ stats: base, createdAt: now - 60_000, now })).toBeNull();
    expect(trendingScore({ stats: { ...base, makers24h: 1 }, createdAt: created, now })).toBeNull();
    expect(trendingScore({ stats: { ...base, liquidityUsd: null }, createdAt: created, now })).toBeNull();
    expect(trendingScore({ stats: { ...base, maxTradeShare24h: 0.95 }, createdAt: created, now })!).toBeLessThan(good);
    expect(trendingScore({ stats: { ...base, buys: { ...base.buys, h1: 30 }, sells: { ...base.sells, h1: 0 } }, createdAt: created, now })!).toBeLessThan(good);
  });
});
