import { describe, expect, it } from 'vitest';
import { breadth, busiestVenues, marketMood, moodLabel, newlyListed, sparkPoints, topGainers, trendingNow } from './overview.js';
import type { MarketRow } from './types.js';

const row = (o: Partial<MarketRow> & { h24?: number | null; v?: number }): MarketRow => ({
  chain: 'base', address: '0x' + 'a'.repeat(40), symbol: 'TKN', quoteSymbol: 'WETH', name: 'Token', icon: null, decimals: 18, pool: '0x' + 'b'.repeat(40),
  priceUsd: 1, capUsd: null, ageMs: 3_600_000, txns24h: 10, volume24hUsd: o.v ?? 5_000, traders24h: 3, change: { m5: null, h1: null, h6: null, h24: o.h24 ?? null },
  liquidityUsd: 50_000, risk: null, fresh: false, ...o,
} as MarketRow);

describe('market mood', () => {
  const many = (n: number, o: Partial<MarketRow> & { h24?: number | null; v?: number }) => Array(n).fill(0).map(() => row(o));

  it('is half breadth and half strength: eight up and four down by 5% is a mildly positive market, not a perfect one', () => {
    const m = marketMood([...many(8, { h24: 5, v: 1_000 }), ...many(4, { h24: -5, v: 1_000 })])!;
    // breadth 8 of 12 = 66.7; strength 50 + (8*5 - 4*5)/12 = 51.7; average 59.2.
    expect(m).toEqual({ score: 59, label: 'Mixed', basis: 12 });
  });

  it('cannot read 100 unless every token is up and the average is up 50%: a day where everything rose 5% is about 75', () => {
    expect(marketMood(many(20, { h24: 5, v: 1_000 }))!.score).toBe(78);
    expect(marketMood(many(20, { h24: 50, v: 1_000 }))!.score).toBe(100);
    expect(marketMood(many(20, { h24: -50, v: 1_000 }))!.score).toBe(0);
  });

  it('caps one token that went up a thousandfold, so it cannot lift a falling market', () => {
    const rows = [...many(15, { h24: -4, v: 1_000 }), row({ h24: 142_896, v: 1_000 })];
    expect(marketMood(rows)!.score).toBeLessThan(40);
  });

  it('does not count a pegged coin as a riser or a faller', () => {
    const rows = [...many(10, { h24: 0.02, v: 1_000 }), ...many(10, { h24: -0.03, v: 1_000 })];
    expect(marketMood(rows)!.score).toBe(50);
  });

  it('weights by the square root of traded value, so many thin pools cannot outvote one big one', () => {
    const rows = [...many(10, { h24: 50, v: 10 }), row({ h24: -2, v: 100_000 })];
    expect(marketMood(rows)!.score).toBeLessThan(40);
  });

  it('shows nothing from too few tokens, or from tokens without a change or a volume', () => {
    expect(marketMood([row({ h24: 5 })])).toBeNull();
    expect(marketMood(many(20, { h24: null }))).toBeNull();
    expect(marketMood(many(20, { h24: 5, v: 0 }))).toBeNull();
  });

  it('has five bands', () => {
    expect([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(moodLabel)).toEqual(['Very weak', 'Very weak', 'Weak', 'Weak', 'Mixed', 'Mixed', 'Strong', 'Strong', 'Very strong', 'Very strong']);
  });
});

describe('breadth', () => {
  it('counts rising, falling and flat, and finds the median change', () => {
    const b = breadth([row({ h24: 10 }), row({ h24: -4 }), row({ h24: 0.2 }), row({ h24: 30 }), row({ h24: null })]);
    expect(b).toEqual({ rising: 2, falling: 1, flat: 1, median: 5.1 });
    expect(breadth([]).median).toBeNull();
  });
});

describe('busiest venues', () => {
  it('ranks by traded value with a volume-weighted change, and caps one outlier', () => {
    const v = busiestVenues([row({ venue: 'Uniswap V2', v: 3_000, h24: 10 }), row({ venue: 'Uniswap V2', v: 1_000, h24: 100_000 }), row({ venue: 'Aerodrome', v: 500, h24: -2 }), row({ v: 9_999 })], 4);
    expect(v.map((x) => x.venue)).toEqual(['Uniswap V2', 'Aerodrome']);
    expect(v[0]!.share).toBeCloseTo(4_000 / 4_500, 6);
    // 3000 at +10% and 1000 capped at +500%: (30000 + 500000) / 4000.
    expect(v[0]!.change).toBeCloseTo(132.5, 6);
    expect(v[0]!.pools).toBe(2);
  });
});

describe('the three short lists', () => {
  it('top gainers are the biggest risers that traded enough to count', () => {
    const rows = [row({ symbol: 'A', h24: 900, v: 10 }), row({ symbol: 'B', h24: 300, v: 5_000 }), row({ symbol: 'C', h24: 50, v: 9_000 }), row({ symbol: 'D', h24: -20, v: 9_000 }), row({ symbol: 'E', h24: 120, v: 2_000 }), row({ symbol: 'F', h24: 10, v: 2_000 })];
    expect(topGainers(rows).map((r) => r.symbol)).toEqual(['B', 'E', 'C']);
  });

  it('newly listed are the youngest pools that have traded', () => {
    const rows = [row({ symbol: 'A', ageMs: 600_000 }), row({ symbol: 'B', ageMs: 60_000, txns24h: 0 }), row({ symbol: 'C', ageMs: 120_000 }), row({ symbol: 'D', ageMs: null })];
    expect(newlyListed(rows).map((r) => r.symbol)).toEqual(['C', 'A']);
  });

  it('trending are the most traded in the last hour, falling back to the day', () => {
    const rows = [row({ symbol: 'A', v: 100, volumeUsd: { m5: null, h1: 900, h6: null, h24: 100 } }), row({ symbol: 'B', v: 500 }), row({ symbol: 'C', v: 0 })];
    expect(trendingNow(rows).map((r) => r.symbol)).toEqual(['A', 'B']);
  });
});

describe('sparkPoints', () => {
  it('draws the line from the price now and its changes, oldest first, never inventing a point', () => {
    const p = sparkPoints({ priceUsd: 2, change: { m5: 0, h1: 0, h6: 0, h24: 100 } })!;
    expect(p.map((x) => x[0])).toEqual([0, 0.75, 1 - 60 / 1440, 1 - 5 / 1440, 1]);
    expect(p[0]![1]).toBe(1);
    expect(p[p.length - 1]).toEqual([1, 2]);
  });

  it('skips a change that cannot be a price (-100% or worse), and gives nothing for fewer than three points or no price', () => {
    expect(sparkPoints({ priceUsd: 2, change: { m5: null, h1: null, h6: null, h24: -100 } })).toBeNull();
    expect(sparkPoints({ priceUsd: 2, change: { m5: null, h1: null, h6: null, h24: 10 } })).toBeNull();
    expect(sparkPoints({ priceUsd: null, change: { m5: 1, h1: 1, h6: 1, h24: 1 } })).toBeNull();
  });
});
