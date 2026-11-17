import { describe, expect, it } from 'vitest';
import { adv } from './adv.js';
import { ammi, depthScore, moodLabel, NO_HISTORY, stabilityScore, type IntelHistory } from './ammi.js';
import { arf, classify } from './arf.js';
import { computeIntel } from './compute.js';
import { DEFAULT_CONFIG, fromMarketRow, quantile, rsiOfChanges, screenTokens, winsorize, type IntelPool } from './common.js';
import { buildSnapshot, historyFrom, rowOf, scopeOf } from './snapshot.js';
import type { MarketRow } from '../types.js';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
let seq = 0;

/** A pool that passes every check, with the given overrides. */
function pool(o: { h24?: number | null; h1?: number | null; h6?: number | null; m5?: number | null; liq?: number; vol?: number | null; venue?: string | null; token?: string; key?: string; age?: number; chain?: string; txns?: number; traders?: number | null; price?: number | null } = {}): IntelPool {
  seq++;
  const chain = o.chain ?? 'bnb';
  return {
    key: o.key ?? `${chain}:pool${seq}`,
    chain,
    token: o.token ?? `${chain}:token${seq}`,
    venue: o.venue === undefined ? 'Uniswap V3' : o.venue,
    priceUsd: o.price === undefined ? 1 : o.price,
    liquidityUsd: o.liq ?? 50_000,
    ageMs: o.age ?? 30 * DAY,
    change: { m5: o.m5 === undefined ? 0 : o.m5, h1: o.h1 === undefined ? 0 : o.h1, h6: o.h6 === undefined ? 0 : o.h6, h24: o.h24 === undefined ? 0 : o.h24 },
    volumeUsd: { m5: null, h1: null, h6: null, h24: o.vol === undefined ? 10_000 : o.vol },
    txns24h: o.txns ?? 100,
    txnsCapped: false,
    traders24h: o.traders === undefined ? 40 : o.traders,
  };
}
const many = (n: number, o: Parameters<typeof pool>[0] = {}): IntelPool[] => Array.from({ length: n }, () => pool(o));

describe('ARF: rising, falling, neutral', () => {
  it('classifies each return exactly once, with the threshold itself neutral', () => {
    expect(classify(0.5)).toBe('neutral');
    expect(classify(-0.5)).toBe('neutral');
    expect(classify(0.51)).toBe('rising');
    expect(classify(-0.51)).toBe('falling');
    expect(classify(0)).toBe('neutral');
  });
  it('the three counts add up to the eligible count and the percentages to 100 (the 101 / 14 / 42 case)', () => {
    const pools = [...many(101, { h24: 5 }), ...many(14, { h24: -5 }), ...many(42, { h24: 0.1 })];
    const r = arf(pools, 'h24');
    expect(r.eligible).toBe(157);
    expect(r.rising + r.falling + r.neutral).toBe(157);
    expect(r.risingPct! + r.fallingPct! + r.neutralPct!).toBeCloseTo(100, 9);
    expect(r.risingPct).toBeCloseTo(64.33, 2);
    expect(r.fallingPct).toBeCloseTo(8.92, 2);
    expect(r.neutralPct).toBeCloseTo(26.75, 2);
    expect(r.netBreadth).toBeCloseTo(55.41, 2);
  });
  it('leaves out, and counts, tokens without a price or a change, with little liquidity, new listings, duplicates and wash trading', () => {
    const t = 'bnb:dup';
    const pools = [
      ...many(5, { h24: 5 }),
      pool({ h24: null }), // stale or no history
      pool({ price: null }),
      pool({ liq: 200, h24: 5 }),
      pool({ age: 3_600_000, h24: 900 }), // an hour old: its "24-hour" change is not one
      pool({ token: t, h24: 4, liq: 90_000 }),
      pool({ token: t, h24: -4, liq: 2_000 }), // the same token on a thinner pool
      pool({ vol: 50_000_000, h24: 30 }), // volume far above what the pool could hold
      pool({ txns: 500, traders: 1, h24: 30 }), // repetitive trading from one account
    ];
    const r = arf(pools, 'h24');
    expect(r.eligible).toBe(6);
    expect(r.rising).toBe(6);
    expect(r.excluded).toEqual({ 'no-change': 1, 'no-price': 1, 'low-liquidity': 1, 'new-listing': 1, duplicate: 1, suspicious: 2 });
    expect(r.considered).toBe(pools.length);
  });
  it('a pool listed twice counts once, and the same address on two networks is two tokens', () => {
    const a = pool({ key: 'bnb:same', h24: 5 });
    expect(arf([a, a, { ...a }], 'h24').eligible).toBe(1);
    expect(arf([pool({ chain: 'bnb', token: 'bnb:0xabc', h24: 5 }), pool({ chain: 'polygon', token: 'polygon:0xabc', h24: 5 })], 'h24').eligible).toBe(2);
  });
  it('works each window on its own', () => {
    const pools = [...many(30, { m5: 3, h1: -3, h6: 0, h24: 8 })];
    expect(arf(pools, 'm5').rising).toBe(30);
    expect(arf(pools, 'h1').falling).toBe(30);
    expect(arf(pools, 'h6').neutral).toBe(30);
    expect(arf(pools, 'h24').rising).toBe(30);
    // A pool younger than the window has no price from before it: 10 minutes old is out of the 5-minute window too (15-minute minimum).
    expect(arf([pool({ age: 600_000, m5: 50 })], 'm5').eligible).toBe(0);
  });
  it('has no percentages, and not zero, when nothing is eligible', () => {
    const r = arf([], 'h24');
    expect(r.eligible).toBe(0);
    expect(r.risingPct).toBeNull();
    expect(r.netBreadth).toBeNull();
  });
});

describe('AMMI: the market mood index', () => {
  const full: IntelHistory = { dailyVolumes: Array.from({ length: 7 }, () => 400_000), hourlyReturns: Array.from({ length: 20 }, (_, i) => (i % 2 ? 0.004 : -0.004)), liquiditySamples: Array.from({ length: 12 }, () => 1_000_000) };
  const vol = (ps: IntelPool[]): number => ps.reduce((s, p) => s + (p.volumeUsd.h24 ?? 0), 0);

  it('is between 0 and 100 and has a label for every score', () => {
    for (const h of [-60, -20, -1, 0, 1, 20, 300]) {
      const ps = many(40, { h24: h });
      const r = ammi(ps, vol(ps), full);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      expect(r.label).toBe(moodLabel(r.score!));
    }
    expect(moodLabel(80)).toBe('Very bullish');
    expect(moodLabel(65)).toBe('Bullish');
    expect(moodLabel(45)).toBe('Neutral');
    expect(moodLabel(25)).toBe('Bearish');
    expect(moodLabel(24)).toBe('Very bearish');
  });
  it('a flat market has a trend score of 50, an everywhere-up market is bullish and an everywhere-down one bearish', () => {
    const flat = many(40, { h24: 0 });
    expect(ammi(flat, vol(flat), full).components.T.score).toBeCloseTo(50, 6);
    const up = many(40, { h24: 12 });
    const down = many(40, { h24: -12 });
    expect(ammi(up, vol(up), full).score!).toBeGreaterThan(65);
    expect(ammi(down, vol(down), full).score!).toBeLessThan(45);
  });
  it('is neutral in a balanced market', () => {
    const mixed = [...many(20, { h24: 6 }), ...many(20, { h24: -6 })];
    const r = ammi(mixed, vol(mixed), full);
    expect(r.components.B.score).toBeCloseTo(50, 6);
    expect(r.score!).toBeGreaterThanOrEqual(40);
    expect(r.score!).toBeLessThanOrEqual(60);
  });
  it('is provisional without history, from T, B and depth with the weights scaled, and says what is missing', () => {
    const ps = many(40, { h24: 10 });
    const r = ammi(ps, vol(ps), NO_HISTORY);
    expect(r.status).toBe('provisional');
    expect(r.components.V.used).toBe(false);
    expect(r.components.V.note).toMatch(/needs 3 earlier days/);
    expect(r.components.M.used).toBe(false);
    expect(r.components.T.used && r.components.B.used && r.components.L.used).toBe(true);
    expect(r.weightUsed).toBeCloseTo(0.65, 9);
  });
  it('is complete only when every part has its history', () => {
    const ps = many(40, { h24: 10 });
    const r = ammi(ps, vol(ps), full);
    expect(r.status).toBe('ok');
    expect(r.weightUsed).toBeCloseTo(1, 9);
    // The usual day is 400,000 (40 tokens at 10,000): volume twice that pushes V above 50, half of it pushes V below.
    expect(r.components.V.score!).toBeCloseTo(50, 6);
    expect(ammi(ps, 800_000, full).components.V.score!).toBeGreaterThan(50);
    expect(ammi(ps, 200_000, full).components.V.score!).toBeLessThan(50);
  });
  it('gives no index, and no score, when there are too few eligible tokens or no usable returns', () => {
    const few = many(5, { h24: 10 });
    const r = ammi(few, vol(few), full);
    expect(r.status).toBe('insufficient');
    expect(r.score).toBeNull();
    expect(r.label).toBeNull();
    const nothing = many(40, { h24: null });
    expect(ammi(nothing, 1, full).score).toBeNull();
  });
  it('winsorizes: one token that went up a thousandfold does not decide the trend', () => {
    const ps = [...many(60, { h24: 0 }), pool({ h24: 100_000 })];
    expect(ammi(ps, vol(ps), full).components.T.score!).toBeLessThan(55);
  });
  it('caps the weight of a huge pool, so it cannot be the market', () => {
    const ps = [...many(40, { h24: -5, liq: 10_000 }), pool({ h24: 50, liq: 5_000_000_000 })];
    // Without the cap the one giant pool would give a strongly positive reading; with it the 40 falling tokens still count.
    expect(ammi(ps, vol(ps), full).components.T.score!).toBeLessThan(50);
  });
  it('measures depth from how little a standard trade moves the price, and stability from steady liquidity', () => {
    expect(depthScore([pool({ liq: 10_000_000, vol: 1000 })])!).toBeGreaterThan(95);
    expect(depthScore([pool({ liq: 2_000, vol: 1000 })])!).toBeLessThan(10);
    expect(depthScore([pool({ vol: null }), pool({ vol: 0 })])).toBeNull();
    expect(stabilityScore(Array.from({ length: 12 }, () => 100))).toBe(100);
    expect(stabilityScore([100, 300, 100, 300, 100, 300, 100, 300])!).toBeLessThan(10);
    expect(stabilityScore([100, 100])).toBeNull();
  });
});

describe('statistics', () => {
  it('quantiles, winsorizing and RSI', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(Number.isNaN(quantile([], 0.5))).toBe(true);
    const xs = [...Array.from({ length: 40 }, () => 0), 1000];
    expect(Math.max(...winsorize(xs))).toBeLessThan(1000);
    expect(winsorize([1, 2, 1000])).toEqual([1, 2, 1000]); // too few to winsorize
    expect(rsiOfChanges(Array.from({ length: 14 }, () => 1))).toBe(100);
    expect(rsiOfChanges(Array.from({ length: 14 }, () => -1))).toBe(0);
    expect(rsiOfChanges(Array.from({ length: 14 }, () => 0))).toBe(50);
    expect(rsiOfChanges(Array.from({ length: 14 }, (_, i) => (i % 2 ? 1 : -1)))).toBe(50);
    expect(rsiOfChanges([1, 2, 3])).toBeNull();
  });
});

describe('ADV: busiest venues', () => {
  it('ranks by deduplicated dollar volume, with shares that add to 100 and a total that reconciles with all venues', () => {
    const p1 = pool({ venue: 'Uniswap V3', vol: 5_000_000, liq: 1_000_000 });
    const pools = [p1, { ...p1 }, pool({ venue: 'Uniswap V3', vol: 1_000_000, liq: 500_000 }), pool({ venue: 'PancakeSwap V2', vol: 3_000_000, liq: 800_000 }), pool({ venue: 'PumpSwap', vol: 500_000, liq: 400_000 })];
    const all = adv(pools, null, 100);
    expect(all.venues.map((v) => v.venue)).toEqual(['Uniswap V3', 'PancakeSwap V2', 'PumpSwap']);
    expect(all.venues[0]!.volume24hUsd).toBe(6_000_000); // the copy of the first pool is not counted
    expect(all.venues.reduce((s, v) => s + v.share, 0)).toBeCloseTo(100, 9);
    expect(all.venues.reduce((s, v) => s + v.volume24hUsd, 0)).toBeCloseTo(all.totalVolume24hUsd, 6);
    expect(adv(pools, null, 2).venues).toHaveLength(2);
    expect(adv(pools, null, 2).totalVolume24hUsd).toBe(all.totalVolume24hUsd); // the total covers every venue, not only the ones shown
    expect(all.venueCount).toBe(3);
  });
  it('growth is against the stored figure for the previous 24 hours, and absent (not zero) without one', () => {
    const pools = [pool({ venue: 'A', vol: 2_000_000, liq: 1_000_000 }), pool({ venue: 'B', vol: 1_000_000, liq: 1_000_000 })];
    expect(adv(pools, null).venues.every((v) => v.growth === null)).toBe(true);
    const r = adv(pools, new Map([['A', 1_000_000]]));
    expect(r.venues.find((v) => v.venue === 'A')!.growth).toBeCloseTo(100, 9);
    expect(r.venues.find((v) => v.venue === 'B')!.growth).toBeNull(); // no earlier figure for B
  });
  it('leaves out wash trading and says how much volume that was, and tells zero volume from missing volume', () => {
    const pools = [
      pool({ venue: 'Real', vol: 1_000_000, liq: 1_000_000 }),
      pool({ venue: 'Wash', vol: 900_000_000, liq: 50_000 }),
      pool({ venue: 'Bots', vol: 400_000, liq: 100_000, txns: 900, traders: 2 }),
      pool({ venue: 'Zero', vol: 0 }),
      pool({ venue: 'Unknown', vol: null }),
      pool({ venue: null, vol: 1_000 }),
      pool({ venue: 'Thin', vol: 1_000, liq: 50 }),
    ];
    const r = adv(pools, null, 100);
    expect(r.venues.map((v) => v.venue)).toEqual(['Real']);
    expect(r.excludedVolume24hUsd).toBe(900_400_000);
    expect(r.excluded).toEqual({ suspicious: 2, 'no-volume': 2, 'no-venue': 1, 'low-liquidity': 1 });
  });
  it('a swap count that is a floor says so', () => {
    const r = adv([{ ...pool({ venue: 'X', vol: 10_000 }), txnsCapped: true }], null);
    expect(r.venues[0]!.swapsCapped).toBe(true);
  });
});

describe('snapshots and history', () => {
  it('builds a snapshot of the inputs and turns stored rows into history', () => {
    const pools = [...many(30, { h24: 5, h1: 1, venue: 'Uniswap V3', vol: 20_000 }), ...many(10, { h24: -5, venue: 'PumpSwap', vol: 10_000 })];
    const snap = buildSnapshot(pools, 'all', NOW);
    expect(snap.eligible).toBe(40);
    expect(snap.volume24h).toBe(700_000);
    expect(snap.arf.h24).toEqual({ rising: 30, falling: 10, neutral: 0 });
    expect(snap.venues.map((v) => v.venue)).toEqual(['Uniswap V3', 'PumpSwap']);
    expect(buildSnapshot(pools, 'solana', NOW).eligible).toBe(0);
    expect(scopeOf('')).toBe('all');
    expect(scopeOf('bnb')).toBe('bnb');
    const rows = [];
    for (let k = 1; k <= 8; k++) rows.push({ ...rowOf(buildSnapshot(pools, 'all', NOW - k * DAY)), volume24h: 100_000 * k });
    for (let h = 1; h <= 30; h++) rows.push({ ...rowOf(buildSnapshot(pools, 'all', NOW - h * 3_600_000 - 120_000)), r1h: h % 2 ? 0.01 : -0.01 });
    const { history, venuesPrev } = historyFrom(rows, NOW);
    expect(history.dailyVolumes.length).toBe(7);
    expect(history.hourlyReturns.length).toBe(24);
    expect(history.liquiditySamples.length).toBeGreaterThan(10);
    expect(venuesPrev?.get('Uniswap V3')).toBeGreaterThan(0);
  });
  it('ignores rows of another methodology version and rows from the future', () => {
    const snap = rowOf(buildSnapshot(many(30, { h24: 5 }), 'all', NOW - DAY));
    expect(historyFrom([{ ...snap, v: 99 }], NOW).history.dailyVolumes).toEqual([]);
    expect(historyFrom([{ ...snap, at: NOW + 1 }], NOW).history.dailyVolumes).toEqual([]);
    expect(historyFrom([snap], NOW).history.dailyVolumes.length).toBe(1);
  });
});

describe('the whole answer', () => {
  it('works one scope out with confidence notes, and says what history it had', () => {
    const pools = [...many(120, { h24: 3, venue: 'Uniswap V3', vol: 40_000 }), ...many(30, { h24: -3, venue: 'PancakeSwap V2', vol: 20_000 })];
    const r = computeIntel(pools, 'all', NOW, { history: NO_HISTORY, venuesPrev: null });
    expect(r.ammi.status).toBe('provisional');
    expect(r.arf.h24.eligible).toBe(150);
    expect(r.adv.venues[0]!.venue).toBe('Uniswap V3');
    expect(r.confidence.arf.level).toBe('high');
    expect(r.confidence.ammi.level).toBe('medium');
    expect(r.confidence.adv.limits.join(' ')).toMatch(/no stored figure/);
    // The current hour's return is the one point of the hourly series it has.
    expect(r.history).toEqual({ days: 0, hourlyReturns: 1, liquiditySamples: 0, venueGrowth: false });
    // A scope with nothing in it has no figures and no confidence, not zeros.
    const empty = computeIntel(pools, 'solana', NOW, { history: NO_HISTORY, venuesPrev: null });
    expect(empty.ammi.score).toBeNull();
    expect(empty.confidence.ammi.level).toBe('none');
    expect(empty.arf.h24.risingPct).toBeNull();
    expect(empty.adv.venues).toEqual([]);
  });
  it('is the same answer for the same inputs', () => {
    const pools = [...many(60, { h24: 4 }), ...many(25, { h24: -2 })];
    const a = computeIntel(pools, 'all', NOW, { history: NO_HISTORY, venuesPrev: null });
    const b = computeIntel(pools, 'all', NOW, { history: NO_HISTORY, venuesPrev: null });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it('reads a Markets row as a pool, and refuses a row it cannot tell apart', () => {
    const row = { chain: 'bnb', address: '0xABC', pool: '0xDEF', symbol: 'X', quoteSymbol: 'WBNB', name: 'X', icon: null, decimals: 18, priceUsd: 2, capUsd: null, ageMs: 5 * DAY, txns24h: 10, volume24hUsd: 500, traders24h: 3, change: { m5: 0, h1: 1, h6: 2, h24: 3 }, liquidityUsd: 9_000, risk: null, fresh: false, venue: ' Uniswap V3 ' } as unknown as MarketRow;
    const p = fromMarketRow(row)!;
    expect(p.key).toBe('bnb:0xdef');
    expect(p.token).toBe('bnb:0xabc');
    expect(p.venue).toBe('Uniswap V3');
    expect(p.volumeUsd.h24).toBe(500);
    expect(fromMarketRow({ ...row, pool: '' } as MarketRow)).toBeNull();
    expect(screenTokens([p], 'h24', DEFAULT_CONFIG).eligible).toHaveLength(1);
  });
});
