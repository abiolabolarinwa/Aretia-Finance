import { beforeEach, describe, expect, it } from 'vitest';
import { chainConfig } from '../chains.js';
import { resetSupplyColumnMemory, readList, type ListQuery, type PoolRecord, type Reader } from '../marketList';
import type { MarketRow } from '../../market/types.js';
import { BUYABLE_MIN_LIQUIDITY_USD, FREEZE_AUTHORITY, MINT_AUTHORITY, flagsOf, ownBuyable } from './buyable';

const NOW = 1_800_000_000_000;
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = chainConfig('solana').quoteTokens.find((t) => t.role === 'usd')!.address;
const mint = (i: number): string => `Mint${String(i).padStart(4, '0')}`.padEnd(44, 'x');
const none = new Set<string>();

const row = (over: Partial<MarketRow> = {}): MarketRow =>
  ({ chain: 'solana', address: mint(1), symbol: 'AAA', quoteSymbol: 'SOL', name: 'a', icon: null, decimals: 6, pool: 'Pool1', priceUsd: 1, capUsd: null, ageMs: 1, txns24h: 500, volume24hUsd: 20_000, traders24h: 300, volumeUsd: { m5: 1, h1: 2, h6: 3, h24: 20_000 }, change: { m5: 1, h1: 2, h6: 3, h24: 4 }, liquidityUsd: 50_000, risk: null, fresh: false, ...over }) as MarketRow;

describe('the mint flags', () => {
  it('are bits: mint authority 1, freeze authority 2, neither 0', () => {
    expect(flagsOf(null, null)).toBe(0);
    expect(flagsOf('x', null)).toBe(MINT_AUTHORITY);
    expect(flagsOf(null, 'y')).toBe(FREEZE_AUTHORITY);
    expect(flagsOf('x', 'y')).toBe(3);
  });
});

describe("Aretia's own rule for what can be bought", () => {
  it('accepts a token with real liquidity, no freeze authority and ordinary trading', () => {
    expect(ownBuyable(row(), 0, none)).toBe(true);
    expect(ownBuyable(row(), MINT_AUTHORITY, none)).toBe(true); // more could be created, but a buyer can still sell
  });
  it('refuses thin liquidity', () => {
    expect(ownBuyable(row({ liquidityUsd: BUYABLE_MIN_LIQUIDITY_USD - 1 }), 0, none)).toBe(false);
    expect(ownBuyable(row({ liquidityUsd: null }), 0, none)).toBe(false);
    expect(ownBuyable(row({ liquidityUsd: BUYABLE_MIN_LIQUIDITY_USD }), 0, none)).toBe(true);
  });
  it("refuses a token whose issuer can freeze accounts, except the chain's own dollar coin", () => {
    expect(ownBuyable(row(), FREEZE_AUTHORITY, none)).toBe(false);
    expect(ownBuyable(row({ address: USDC }), FREEZE_AUTHORITY, new Set([USDC]))).toBe(true);
  });
  it('does not list a token whose mint was never read', () => {
    expect(ownBuyable(row(), null, none)).toBe(false);
    expect(ownBuyable(row(), undefined, none)).toBe(false);
  });
  it('refuses wash trading: volume far above the pool, many trades from a few accounts, or a few accounts looping it', () => {
    expect(ownBuyable(row({ liquidityUsd: 2_000, volumeUsd: { m5: 0, h1: 0, h6: 0, h24: 500_000 } }), 0, none)).toBe(false); // 250 times its liquidity
    expect(ownBuyable(row({ txns24h: 400, traders24h: 4 }), 0, none)).toBe(false);
    expect(ownBuyable(row({ liquidityUsd: 100_000, traders24h: 5, txns24h: 8, volumeUsd: { m5: 0, h1: 0, h6: 0, h24: 4_000_000 } }), 0, none)).toBe(false); // 800k each, 8 times the pool
  });
});

const q = (over: Partial<ListQuery> = {}): ListQuery => ({ kind: 'top', chain: 'solana', window: 'h24', sort: 'rank', dir: 'desc', page: 1, size: 50, minLiquidityUsd: 1000, maxAgeHours: 0, ...over });
const pool = (i: number, over: Partial<PoolRecord> = {}): PoolRecord => ({
  key: `solana:Pool${i}`,
  chain: 'solana',
  address: `Pool${i}`,
  adapter_id: 'meteora-damm-v2-solana',
  dex: 'meteora',
  base: mint(i),
  quote: SOL,
  base_decimals: 6,
  created_at: NOW - 3_600_000,
  liquidity_usd: 60_000,
  vol24_usd: 9_000 - i,
  p_usd: 0.5,
  chg: { m5: 1, h1: 2, h6: 3, h24: 4 },
  buys: { m5: 1, h1: 5, h6: 20, h24: 200 },
  sells: { m5: 1, h1: 4, h6: 18, h24: 150 },
  vol: { m5: 1, h1: 5, h6: 20, h24: 9_000 - i },
  mk: 200,
  ro: false,
  ...over,
});
/** A database whose token rows carry the given mint flags (undefined: the column is not there). */
function db(pools: PoolRecord[], flags: Record<string, number | null> | undefined, symbols: Record<string, string> = {}) {
  const paths: string[] = [];
  const reader: Reader = {
    async get(path) {
      paths.push(path);
      if (path.startsWith('mi_tokens')) {
        if (!flags && path.includes('mint_flags')) throw new Error('The Market Indexer database answered 400.');
        const keys = [...path.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
        return { rows: keys.map((key) => ({ key, symbol: symbols[key.replace('solana:', '')] ?? `T${key.slice(7, 15)}`, name: 'n', decimals: 6, ...(flags ? { mint_flags: flags[key.replace('solana:', '')] ?? null } : {}) })), total: null };
      }
      return { rows: pools, total: pools.length };
    },
  };
  return { reader, paths };
}
const jupiterWasAsked = { count: 0 };
const jupiterCheck = async () => {
  jupiterWasAsked.count++;
  return null;
};

describe('Solana lists by the own rule', () => {
  beforeEach(() => {
    resetSupplyColumnMemory();
    jupiterWasAsked.count = 0;
  });

  it("lists only what passes, in the database's own order, with no outside service asked", async () => {
    const pools = [1, 2, 3, 4, 5].map((i) => pool(i));
    pools[1] = pool(2, { liquidity_usd: 400 }); // thin
    const flags = { [mint(1)]: 0, [mint(2)]: 0, [mint(3)]: 2, [mint(4)]: 1, [mint(5)]: 0 }; // 3 can freeze
    const a = await readList(db(pools, flags).reader, q(), NOW, jupiterCheck, undefined, true);
    expect(a.rows.map((r) => r.address)).toEqual([mint(1), mint(4), mint(5)]);
    expect(a.note).toContain("Aretia's own checks");
    expect(jupiterWasAsked.count).toBe(0);
  });

  it('keeps one row per symbol, the best-ranked', async () => {
    const pools = [1, 2, 3].map((i) => pool(i));
    const flags = { [mint(1)]: 0, [mint(2)]: 0, [mint(3)]: 0 };
    const a = await readList(db(pools, flags, { [mint(1)]: 'ANT', [mint(2)]: 'ant', [mint(3)]: 'BONK' }).reader, q(), NOW, undefined, undefined, true);
    expect(a.rows.map((r) => r.address)).toEqual([mint(1), mint(3)]);
  });

  it('a token whose mint was never read is left out while most have been read', async () => {
    const pools = [1, 2, 3, 4].map((i) => pool(i));
    const flags = { [mint(1)]: 0, [mint(2)]: 0, [mint(3)]: 0, [mint(4)]: null };
    const a = await readList(db(pools, flags).reader, q(), NOW, undefined, undefined, true);
    expect(a.rows.map((r) => r.address)).toEqual([mint(1), mint(2), mint(3)]);
  });

  it('falls back to the outside checks while the flags are mostly unread (before the first supply pass, or the column is not there)', async () => {
    const pools = [1, 2, 3, 4].map((i) => pool(i));
    for (const flags of [{ [mint(1)]: 0 }, undefined]) {
      resetSupplyColumnMemory();
      const a = await readList(db(pools, flags).reader, q(), NOW, jupiterCheck, undefined, true);
      expect(a.rows).toHaveLength(4); // the outside check failed (null), so the list is shown as it was
      expect(a.note).not.toContain("Aretia's own checks");
    }
    expect(jupiterWasAsked.count).toBe(2);
  });

  it('reads only pools that can pass the liquidity floor, so tokens of tiny pools do not hold up the switch', async () => {
    const pools = [pool(1), pool(2)];
    const d = db(pools, { [mint(1)]: 0, [mint(2)]: 0 });
    await readList(d.reader, q({ minLiquidityUsd: 100 }), NOW, undefined, undefined, true);
    expect(d.paths.find((p) => p.startsWith('mi_pools'))).toContain(`liquidity_usd=gte.${BUYABLE_MIN_LIQUIDITY_USD}`);
    const d2 = db(pools, { [mint(1)]: 0, [mint(2)]: 0 });
    await readList(d2.reader, q({ minLiquidityUsd: 25_000 }), NOW, undefined, undefined, true);
    expect(d2.paths.find((p) => p.startsWith('mi_pools'))).toContain('liquidity_usd=gte.25000'); // a higher floor the reader chose is kept
  });

  it('is not used when switched off', async () => {
    const pools = [1, 2].map((i) => pool(i));
    const flags = { [mint(1)]: 2, [mint(2)]: 2 }; // both can freeze: the own rule would drop both
    const off = await readList(db(pools, flags).reader, q(), NOW, undefined, undefined, false);
    expect(off.rows).toHaveLength(2);
  });

  it('reads the mint flags with the token rows, and an older database that lacks the column still lists', async () => {
    const pools = [pool(1)];
    const withColumn = db(pools, { [mint(1)]: 0 });
    await readList(withColumn.reader, q(), NOW, undefined, undefined, true);
    expect(withColumn.paths.some((p) => p.startsWith('mi_tokens') && p.includes('mint_flags') && p.includes('total_supply'))).toBe(true);
    resetSupplyColumnMemory();
    const old = db(pools, undefined);
    const a = await readList(old.reader, q(), NOW, undefined, undefined, true);
    expect(a.rows).toHaveLength(1);
  });
});
