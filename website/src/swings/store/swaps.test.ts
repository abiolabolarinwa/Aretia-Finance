import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildCandles, decodeSolanaSwap, InMemorySwapStore, makeSwap, type ParsedTx, type SwapRecord, type TrackedPool } from './swaps.js';

const POOL: TrackedPool = { chain: 'solana', pool: 'PoolAddr1111111111111111111111111111111111', venue: 'meteora-damm-v2', baseMint: 'ACTmint', quoteMint: 'USDCmint', baseDecimals: 9, quoteDecimals: 6, baseVault: 'BaseVault', quoteVault: 'QuoteVault' };

/** A transaction whose two pool vaults changed by the given raw amounts (negative = the vault paid out). */
function tx(dBase: bigint | null, dQuote: bigint | null, over: Partial<ParsedTx> = {}): ParsedTx {
  const pre = 1_000_000_000_000n;
  const bal = (i: number, v: bigint) => ({ accountIndex: i, uiTokenAmount: { amount: v.toString() } });
  return {
    slot: 42,
    blockTime: 1_700_000_000,
    meta: {
      err: null,
      preTokenBalances: [...(dBase === null ? [] : [bal(1, pre)]), ...(dQuote === null ? [] : [bal(2, pre)])],
      postTokenBalances: [...(dBase === null ? [] : [bal(1, pre + dBase)]), ...(dQuote === null ? [] : [bal(2, pre + dQuote)])],
    },
    transaction: { message: { accountKeys: [{ pubkey: 'Payer' }, { pubkey: 'BaseVault' }, { pubkey: 'QuoteVault' }] } },
    ...over,
  };
}

describe('makeSwap', () => {
  it('prices the base token in the quote token with decimals applied', () => {
    const s = makeSwap(POOL, { id: 'a', time: 100, seq: 1, baseAmount: 1_000_000_000n, quoteAmount: 5_000n, side: 'buy' })!;
    expect(s.price).toBeCloseTo(0.005);
    expect(s.quoteVolume).toBeCloseTo(0.005);
    expect(s.baseAmount).toBe('1000000000');
  });
  it('refuses zero or negative amounts, a bad time, and numbers that do not make a price', () => {
    const o = { id: 'a', time: 100, seq: 1, side: 'buy' as const };
    expect(makeSwap(POOL, { ...o, baseAmount: 0n, quoteAmount: 5n })).toBeNull();
    expect(makeSwap(POOL, { ...o, baseAmount: 5n, quoteAmount: -1n })).toBeNull();
    expect(makeSwap(POOL, { ...o, time: 0, baseAmount: 5n, quoteAmount: 5n })).toBeNull();
    expect(makeSwap(POOL, { ...o, time: 1.5, baseAmount: 5n, quoteAmount: 5n })).toBeNull();
  });
});

describe('decodeSolanaSwap', () => {
  it('reads a buy (the pool paid out base tokens and took in quote) from the vault changes', () => {
    const s = decodeSolanaSwap(tx(-1_000_000_000n, 5_000n), 'sigBuy', POOL)!;
    expect(s).toMatchObject({ id: 'sigBuy', side: 'buy', time: 1_700_000_000, seq: 42, baseAmount: '1000000000', quoteAmount: '5000', chain: 'solana', pool: POOL.pool });
    expect(s.price).toBeCloseTo(0.005);
  });
  it('reads a sell the other way round', () => {
    expect(decodeSolanaSwap(tx(2_000_000_000n, -10_000n), 'sigSell', POOL)!.side).toBe('sell');
  });
  it('ignores liquidity moves (both vaults up or both down), untouched pools, and one-sided changes', () => {
    expect(decodeSolanaSwap(tx(5n, 5n), 's', POOL)).toBeNull();
    expect(decodeSolanaSwap(tx(-5n, -5n), 's', POOL)).toBeNull();
    expect(decodeSolanaSwap(tx(null, null), 's', POOL)).toBeNull();
    expect(decodeSolanaSwap(tx(5n, null), 's', POOL)).toBeNull();
    expect(decodeSolanaSwap(tx(0n, 5n), 's', POOL)).toBeNull();
  });
  it('ignores failed transactions, missing times, and pools with no vaults configured', () => {
    expect(decodeSolanaSwap(tx(-5n, 5n, { meta: { err: { InstructionError: [0, 'x'] }, preTokenBalances: [], postTokenBalances: [] } }), 's', POOL)).toBeNull();
    expect(decodeSolanaSwap(tx(-5n, 5n, { blockTime: null }), 's', POOL)).toBeNull();
    expect(decodeSolanaSwap(null, 's', POOL)).toBeNull();
    expect(decodeSolanaSwap(tx(-5n, 5n), 's', { ...POOL, baseVault: undefined })).toBeNull();
  });
  it('finds vaults that arrive through an address lookup table', () => {
    const t = tx(-1_000_000_000n, 5_000n, { transaction: { message: { accountKeys: [{ pubkey: 'Payer' }] } } });
    t.meta!.loadedAddresses = { writable: ['BaseVault', 'QuoteVault'], readonly: [] };
    expect(decodeSolanaSwap(t, 's', POOL)).not.toBeNull();
  });
  it('treats a vault that only exists after the transaction as starting from zero, and reads bare-string account keys', () => {
    const t: ParsedTx = { blockTime: 100, slot: 1, meta: { err: null, preTokenBalances: [], postTokenBalances: [{ accountIndex: 1, uiTokenAmount: { amount: '7' } }, { accountIndex: 2, uiTokenAmount: { amount: '9' } }] }, transaction: { message: { accountKeys: ['Payer', 'BaseVault', 'QuoteVault'] } } };
    expect(decodeSolanaSwap(t, 's', POOL)).toBeNull(); // both up: liquidity
  });
});

describe('buildCandles', () => {
  const swap = (time: number, price: number, vol = 1, seq = 0, id = `s${time}-${seq}`): SwapRecord => ({ chain: 'solana', pool: 'p', id, time, seq, side: 'buy', baseAmount: '1', quoteAmount: '1', price, quoteVolume: vol });

  it('builds open, high, low, close, volume and trades per period, oldest first, with no empty periods', () => {
    const c = buildCandles([swap(10, 1), swap(20, 3), swap(30, 2), swap(70, 5), swap(75, 4)], 60);
    expect(c).toEqual([
      { time: 0, open: 1, high: 3, low: 1, close: 2, volume: 3, trades: 3 },
      { time: 60, open: 5, high: 5, low: 4, close: 4, volume: 2, trades: 2 },
    ]);
    expect(buildCandles([swap(10, 1), swap(500, 2)], 60).map((x) => x.time)).toEqual([0, 480]);
  });
  it('does not depend on the order the swaps arrive in, and orders ties inside one second by sequence', () => {
    const a = [swap(10, 1, 1, 1), swap(10, 2, 1, 2), swap(20, 3)];
    expect(buildCandles([...a].reverse(), 60)).toEqual(buildCandles(a, 60));
    expect(buildCandles(a, 60)[0]).toMatchObject({ open: 1, close: 3 });
  });
  it('returns nothing for no swaps or a bad length', () => {
    expect(buildCandles([], 60)).toEqual([]);
    expect(buildCandles([swap(1, 1)], 0)).toEqual([]);
    expect(buildCandles([swap(1, 1)], 1.5)).toEqual([]);
  });
  it('property: every candle is consistent, and the volume and trades add up to the input', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ time: fc.integer({ min: 1, max: 100_000 }), price: fc.double({ min: 1e-9, max: 1e9, noNaN: true }), vol: fc.double({ min: 0, max: 1e6, noNaN: true }), seq: fc.integer({ min: 0, max: 5 }) }), { maxLength: 60 }), fc.constantFrom(60, 900, 3600), (rows, secs) => {
        const swaps = rows.map((r, i) => swap(r.time, r.price, r.vol, r.seq, `x${i}`));
        const c = buildCandles(swaps, secs);
        const strictlyIncreasing = c.every((x, i) => i === 0 || x.time > c[i - 1]!.time);
        const consistent = c.every((x) => x.high >= x.low && x.open <= x.high && x.open >= x.low && x.close <= x.high && x.close >= x.low);
        const trades = c.reduce((n, x) => n + x.trades, 0);
        const volume = c.reduce((n, x) => n + x.volume, 0);
        return strictlyIncreasing && consistent && trades === swaps.length && Math.abs(volume - swaps.reduce((n, s) => n + s.quoteVolume, 0)) < 1e-3 * Math.max(1, volume);
      }),
    );
  });
});

describe('InMemorySwapStore', () => {
  const r = (id: string, time: number, price = 1, pool = 'p'): SwapRecord => ({ chain: 'solana', pool, id, time, seq: 0, side: 'buy', baseAmount: '1', quoteAmount: '1', price, quoteVolume: 1 });
  it('stores each swap once, however many times it is offered', async () => {
    const s = new InMemorySwapStore();
    expect(await s.put([r('a', 1), r('b', 2)])).toBe(2);
    expect(await s.put([r('a', 1), r('c', 3)])).toBe(1);
    expect((await s.list('solana', 'p', 0, 10)).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
  it('keeps pools apart, filters by time, reports coverage, and remembers a cursor per pool', async () => {
    const s = new InMemorySwapStore();
    await s.put([r('a', 5), r('b', 50), r('x', 7, 1, 'other')]);
    expect((await s.list('solana', 'p', 0, 10)).map((x) => x.id)).toEqual(['a']);
    expect(await s.coverage('solana', 'p')).toEqual({ swaps: 2, first: 5, last: 50 });
    expect(await s.coverage('solana', 'none')).toBeNull();
    expect(await s.getCursor('solana', 'p')).toBeNull();
    await s.setCursor('solana', 'p', 'sig');
    expect(await s.getCursor('solana', 'p')).toBe('sig');
    expect(await s.getCursor('solana', 'other')).toBeNull();
    expect((await s.candles('solana', 'p', 60, 0, 100)).length).toBe(1);
  });
});
