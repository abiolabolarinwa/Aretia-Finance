import { describe, expect, it } from 'vitest';
import { priceFromSqrt } from './math.js';
import { liquidityOnly } from './refresher.js';
import { decodeAggregate3Data, readReservesBatch, reservePriceOf } from './reserves.js';
import { rowFromRecord, type PoolRecord } from './marketList.js';

const Q96 = 1n << 96n;
const E18 = 10n ** 18n;
const NOW = 1_700_000_000_000;
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const hex = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`;

describe('priceFromSqrt', () => {
  it('reads sqrtPriceX96 as raw token1 per raw token0 and converts for decimals and order', () => {
    expect(priceFromSqrt(Q96, true, 18, 18)).toBe('1');
    expect(priceFromSqrt(2n * Q96, true, 18, 18)).toBe('4'); // token1 per token0 = 4
    expect(priceFromSqrt(2n * Q96, false, 18, 18)).toBe('0.25'); // base is token1, so token0 per token1
    // 18-decimal base, 6-decimal quote, raw ratio 1 -> 1e12 whole quote per whole base, either way round
    expect(priceFromSqrt(Q96, true, 18, 6)).toBe('1000000000000');
    expect(priceFromSqrt(Q96, false, 18, 6)).toBe('1000000000000');
  });
  it('gives nothing for a zero price', () => {
    expect(priceFromSqrt(0n, true, 18, 18)).toBeNull();
  });
});

describe('reservePriceOf', () => {
  it('V2: the reserve ratio, and dollars only when the quote has a dollar value', () => {
    const r = { base: 1_000n * E18, quote: 2n * E18 };
    expect(reservePriceOf('v2', r, true, 18, 18, 600)).toEqual({ price: '0.002', usd: 1.2 });
    expect(reservePriceOf('v2', r, true, 18, 18, null)).toEqual({ price: '0.002', usd: null });
  });
  it('V3: the pool own price, never the balance ratio', () => {
    // balances say 1:1000 but the pool price is 4 token1 per token0
    const r = { base: 1n * E18, quote: 1_000n * E18, sqrtPriceX96: 2n * Q96 };
    expect(reservePriceOf('v3', r, true, 18, 18, 1)).toEqual({ price: '4', usd: 4 });
    expect(reservePriceOf('v3', { base: 1n, quote: 1n }, true, 18, 18, 1)).toBeNull(); // no slot0 answer, no price
  });
  it('is nothing for an empty side', () => {
    expect(reservePriceOf('v2', { base: 0n, quote: 5n }, true, 18, 18, 1)).toBeNull();
    expect(reservePriceOf('v2', { base: 5n, quote: 0n }, true, 18, 18, 1)).toBeNull();
  });
});

describe('liquidityOnly with a reserve price', () => {
  it('keeps the trade price absent and adds the reserve price beside it', () => {
    const s = liquidityOnly(NOW, 600, 200, 120_000, { price: '0.0001', usd: 0.06 });
    expect(s.reservesOnly).toBe(true);
    expect(s.price).toBeNull();
    expect(s.priceUsd).toBeNull();
    expect(s.reservePrice).toBe('0.0001');
    expect(s.reservePriceUsd).toBe(0.06);
    expect(liquidityOnly(NOW, 600, 200, 120_000).reservePriceUsd).toBeUndefined();
  });
});

describe('readReservesBatch for a V3 pool', () => {
  it('asks for the pool price too, and still answers when that call fails', async () => {
    const w = (n: bigint): string => n.toString(16).padStart(64, '0');
    const item = (ok: boolean, data: string): string => w(ok ? 1n : 0n) + w(0x40n) + w(BigInt(data.length / 2)) + data + '0'.repeat((64 - (data.length % 64)) % 64);
    const answer = (items: string[]): string => {
      let off = 32 * items.length;
      const offs = items.map((b) => {
        const o = off;
        off += b.length / 2;
        return w(BigInt(o));
      });
      return '0x' + w(0x20n) + w(BigInt(items.length)) + offs.join('') + items.join('');
    };
    for (const slotOk of [true, false]) {
      const read = async (_m: string, params: unknown[]): Promise<string> => {
        const call = params[0] as { data: string };
        // 3 inner calls for one V3 pool: two balanceOf and one slot0
        expect(decodeAggregate3Data(answer([item(true, w(5n)), item(true, w(7n)), item(slotOk, w(2n * Q96))])).length).toBe(3);
        void call;
        return answer([item(true, w(5n)), item(true, w(7n)), item(slotOk, w(2n * Q96))]);
      };
      const [res] = await readReservesBatch(read as never, [{ kind: 'v3', pool: hex(1), base: hex(2), quote: hex(3), baseIsToken0: true }]);
      expect(res).toMatchObject({ base: 5n, quote: 7n });
      expect(res?.sqrtPriceX96).toBe(slotOk ? 2n * Q96 : undefined);
    }
  });
});

describe('the Markets row for a pool without trades', () => {
  const rec = (over: Partial<PoolRecord>): PoolRecord => ({
    key: `bnb:${hex(1001)}`,
    chain: 'bnb',
    address: hex(1001),
    adapter_id: 'pancakeswap-v2-bnb',
    dex: 'pancakeswap',
    base: hex(1),
    quote: WBNB,
    base_decimals: 18,
    created_at: NOW - 3_600_000,
    liquidity_usd: 5000,
    vol24_usd: null,
    p_usd: null,
    chg: null,
    buys: null,
    sells: null,
    vol: null,
    ro: true,
    ...over,
  });
  const tokens = new Map([[`bnb:${hex(1)}`, { symbol: 'MEME', name: 'Meme', decimals: 18 }]]);
  it('shows the reserve price marked as such, and no trade numbers', () => {
    const r = rowFromRecord(rec({ rp: 0.06 }), tokens, NOW)!;
    expect(r.priceUsd).toBe(0.06);
    expect(r.priceFromReserves).toBe(true);
    expect(r.volume24hUsd).toBeNull();
    expect(r.txns24h).toBeNull();
  });
  it('shows a dash when there is no reserve price, and never lets it replace a traded price', () => {
    const none = rowFromRecord(rec({ rp: null }), tokens, NOW)!;
    expect(none.priceUsd).toBeNull();
    expect(none.priceFromReserves).toBeUndefined();
    const traded = rowFromRecord(rec({ ro: false, p_usd: 1.5, rp: 0.06, chg: { m5: 0, h1: 0, h6: 0, h24: 0 }, buys: { m5: 0, h1: 0, h6: 0, h24: 1 }, sells: { m5: 0, h1: 0, h6: 0, h24: 0 }, vol: { m5: 0, h1: 0, h6: 0, h24: 10 } }), tokens, NOW)!;
    expect(traded.priceUsd).toBe(1.5);
    expect(traded.priceFromReserves).toBeUndefined();
  });
  it('ignores a reserve price that is not a positive number', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(rowFromRecord(rec({ rp: bad }), tokens, NOW)!.priceUsd).toBeNull();
  });
});
