import { beforeEach, describe, expect, it } from 'vitest';
import { readList, resetSupplyColumnMemory, type ListQuery, type PoolRecord, type Reader } from '../marketList';
import { MAX_PACE, TREND_FLOOR_USD, paceOf, trendingScore } from './trending';

const NOW = 1_800_000_000_000;
const SOL = 'So11111111111111111111111111111111111111112';
const mint = (i: number): string => `Mint${String(i).padStart(4, '0')}`.padEnd(44, 'x');

const vol = (h24: number, h6: number, h1: number, m5 = 0) => ({ volumeUsd: { m5, h1, h6, h24 } });

describe('the pace of a window against the day', () => {
  it('is the window\'s value over its share of the day\'s value', () => {
    expect(paceOf(vol(240_000, 0, 10_000), 'h1')).toBeCloseTo(1, 5); // 10k in an hour, 240k a day: an ordinary hour
    expect(paceOf(vol(240_000, 0, 30_000), 'h1')).toBeCloseTo(3, 5);
    expect(paceOf(vol(240_000, 60_000, 0), 'h6')).toBeCloseTo(1, 5);
    expect(paceOf(vol(2_880_000, 0, 0, 10_000), 'm5')).toBeCloseTo(1, 5); // 288 five-minute slots a day
  });
  it('compares the last six hours with the day on the 24-hour tab', () => {
    expect(paceOf(vol(240_000, 120_000, 0), 'h24')).toBeCloseTo(2, 5);
  });
  it('is null without the numbers', () => {
    expect(paceOf({ volumeUsd: undefined }, 'h1')).toBeNull();
    expect(paceOf(vol(0, 0, 5), 'h1')).toBeNull();
  });
});

describe('the trending score', () => {
  it('rewards a busier window, with a boost that grows slowly', () => {
    const slow = trendingScore(vol(240_000, 0, 10_000), 'h1'); // pace 1
    const fast = trendingScore(vol(240_000, 0, 40_000), 'h1'); // pace 4, 4x the value
    expect(slow).toBeCloseTo(10_000, 5);
    expect(fast).toBeCloseTo(40_000 * 2, 5); // sqrt(4)
    expect(fast).toBeGreaterThan(slow);
  });
  it('does not rank a token that is slowing down, or one below the floor, or one with no numbers', () => {
    expect(trendingScore(vol(240_000, 0, 5_000), 'h1')).toBe(0); // pace 0.5
    expect(trendingScore(vol(2_000, 0, TREND_FLOOR_USD.h1 - 1), 'h1')).toBe(0);
    expect(trendingScore({ volumeUsd: undefined }, 'h1')).toBe(0);
  });
  it('caps the boost, so one burst cannot dominate', () => {
    // five minutes with half the day's value: a pace of 144, held to the cap of 25
    const burst = trendingScore(vol(100_000, 0, 0, 50_000), 'm5');
    expect(burst).toBeCloseTo(50_000 * Math.sqrt(MAX_PACE), 3);
    // below the cap the boost is the square root of the pace
    expect(trendingScore(vol(24_000, 0, 24_000), 'h1')).toBeCloseTo(24_000 * Math.sqrt(24), 3);
  });
});

const q = (over: Partial<ListQuery> = {}): ListQuery => ({ kind: 'trending', chain: 'solana', window: 'h1', sort: 'rank', dir: 'desc', page: 1, size: 50, minLiquidityUsd: 1000, maxAgeHours: 0, ...over });
const pool = (i: number, h24: number, h6: number, h1: number): PoolRecord => ({
  key: `solana:Pool${i}`,
  chain: 'solana',
  address: `Pool${i}`,
  adapter_id: 'meteora-damm-v2-solana',
  dex: 'meteora',
  base: mint(i),
  quote: SOL,
  base_decimals: 6,
  created_at: NOW - 86_400_000,
  liquidity_usd: 400_000,
  vol24_usd: h24,
  p_usd: 0.5,
  chg: { m5: 1, h1: 2, h6: 3, h24: 4 },
  buys: { m5: 1, h1: 50, h6: 100, h24: 400 },
  sells: { m5: 1, h1: 40, h6: 90, h24: 380 },
  vol: { m5: 10, h1, h6, h24 },
  mk: 300,
  ro: false,
});
function db(pools: PoolRecord[]) {
  const paths: string[] = [];
  const reader: Reader = {
    async get(path) {
      paths.push(path);
      if (path.startsWith('mi_tokens')) {
        const keys = [...path.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
        return { rows: keys.map((key) => ({ key, symbol: `T${key.slice(7, 15)}`, name: 'n', decimals: 6, mint_flags: 0 })), total: null };
      }
      return { rows: pools, total: pools.length };
    },
  };
  return { reader, paths };
}

describe('Solana Trending by momentum', () => {
  beforeEach(resetSupplyColumnMemory);

  // (The database sorts a Top list by the day's value itself; the fake is given the pools in that order.)
  // A: the biggest, steady (an ordinary hour). B: smaller but its last hour is far busier than its day. C: big, but slowing down. D: busy hour, below the floor.
  const A = pool(1, 576_000, 144_000, 24_000);
  const B = pool(2, 100_000, 40_000, 30_000);
  const C = pool(3, 200_000, 20_000, 2_000);
  const D = pool(4, 5_000, 2_000, 500);

  it('puts the token speeding up above the bigger steady one, and leaves out the slowing and the dust', async () => {
    const a = await readList(db([A, B, C, D]).reader, q(), NOW, undefined, undefined, true);
    expect(a.rows.map((r) => r.address)).toEqual([mint(2), mint(1)]);
    expect(a.note).toContain('speeding up');
  });

  it('is a different list from Top, which stays by value traded over the day', async () => {
    const top = await readList(db([A, C, B, D]).reader, q({ kind: 'top', window: 'h24' }), NOW, undefined, undefined, true);
    expect(top.rows.map((r) => r.address).slice(0, 3)).toEqual([mint(1), mint(3), mint(2)]);
  });

  it('reads the wide window of pools whatever the tab, not only the few hundred busiest', async () => {
    for (const window of ['m5', 'h1', 'h6', 'h24'] as const) {
      const d = db([A, B]);
      await readList(d.reader, q({ window }), NOW, undefined, undefined, true);
      expect(d.paths.filter((p) => p.startsWith('mi_pools')).some((p) => p.includes('limit=600'))).toBe(false);
    }
  });

  it('on the 24-hour tab ranks by the last six hours against the day', async () => {
    const a = await readList(db([A, B, C]).reader, q({ window: 'h24', minLiquidityUsd: 1000 }), NOW, undefined, undefined, true);
    // vol24: A 576k, h6 144k -> pace 1; B 100k, h6 40k -> pace 1.6; C 200k, h6 20k -> pace 0.4 (left out)
    expect(a.rows.map((r) => r.address)).toEqual([mint(1), mint(2)]);
  });

  it('does not change another network or the bullish filter', async () => {
    const bnb = [A, B].map((p) => ({ ...p, chain: 'bnb' as const }));
    const a = await readList(db(bnb).reader, q({ chain: 'bnb' }), NOW, undefined, undefined, true);
    expect(a.note).not.toContain('speeding up');
  });
});
