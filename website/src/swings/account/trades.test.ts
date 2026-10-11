import { describe, expect, it } from 'vitest';
import { classify, parseCandles, parseSolanaTx, priceAt, priceOf, SOL_MINT, summariseSwap, type RawTx } from './trades.js';

const W = '8s2TcBz5e8jvFZDVx9gJqW175JK3kpVGX1a6D4WnDRHz';
const OTHER = 'Pool1111111111111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ACT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const tb = (accountIndex: number, mint: string, owner: string, ui: string) => ({ accountIndex, mint, owner, uiTokenAmount: { uiAmountString: ui } });

/** A transaction as `getTransaction` (jsonParsed) returns it, with the wallet as the fee payer and account 0. */
const tx = (o: Partial<NonNullable<RawTx['meta']>> & { keys?: string[]; blockTime?: number }): RawTx => ({
  blockTime: o.blockTime ?? 1_790_000_000,
  transaction: { message: { accountKeys: (o.keys ?? [W, 'TokenAcct1', 'TokenAcct2', OTHER]).map((pubkey) => ({ pubkey })) } },
  meta: { err: null, fee: 5000, preBalances: [1e9, 2_039_280, 2_039_280, 5e9], postBalances: [1e9 - 5000, 2_039_280, 2_039_280, 5e9], preTokenBalances: [], postTokenBalances: [], ...o },
});

describe('parseSolanaTx', () => {
  it('reads a sale: tokens leave the wallet, USDC arrives, and the other owners are ignored', () => {
    const p = parseSolanaTx(
      'sig1',
      tx({
        preTokenBalances: [tb(1, ACT, W, '1113.436513625'), tb(2, USDC, W, '0'), tb(3, USDC, OTHER, '900')],
        postTokenBalances: [tb(1, ACT, W, '0'), tb(2, USDC, W, '5.049636'), tb(3, USDC, OTHER, '894.95')],
      }),
      W,
    )!;
    expect(p.ok).toBe(true);
    expect(p.spent).toEqual([{ mint: ACT, amount: 1113.436513625 }]);
    expect(p.gained).toHaveLength(1);
    expect(p.gained[0]).toMatchObject({ mint: USDC });
    expect(p.gained[0]!.amount).toBeCloseTo(5.049636, 9);
  });

  it('puts the network fee back, so paying it is not a SOL leg', () => {
    const p = parseSolanaTx('sig2', tx({ preTokenBalances: [tb(1, ACT, W, '10'), tb(2, USDC, W, '0')], postTokenBalances: [tb(1, ACT, W, '0'), tb(2, USDC, W, '1')] }), W)!;
    expect(p.spent.map((l) => l.mint)).toEqual([ACT]);
    expect(p.gained.map((l) => l.mint)).toEqual([USDC]);
  });

  it('leaves the deposit for a newly opened token account out of the SOL spent', () => {
    // The wallet paid 0.05 SOL for the token plus 0.00203928 SOL to open the token account, plus the fee.
    const p = parseSolanaTx(
      'sig3',
      tx({
        preBalances: [1_000_000_000, 0, 5e9],
        postBalances: [1_000_000_000 - 5000 - 50_000_000 - 2_039_280, 2_039_280, 5e9],
        postTokenBalances: [tb(1, ACT, W, '1181.26')],
        keys: [W, 'NewTokenAcct', OTHER],
      }),
      W,
    )!;
    expect(p.spent).toHaveLength(1);
    expect(p.spent[0]).toMatchObject({ mint: SOL_MINT });
    expect(p.spent[0]!.amount).toBeCloseTo(0.05, 9);
    expect(p.gained).toEqual([{ mint: ACT, amount: 1181.26 }]);
  });

  it('treats wrapped SOL and native SOL as one asset', () => {
    // Wrapped 1 SOL, swapped the wrapped SOL for USDC, closed the wrapper: native SOL down by 1, wrapped SOL net zero.
    const p = parseSolanaTx(
      'sig4',
      tx({
        preBalances: [3_000_000_000, 0, 5e9],
        postBalances: [2_000_000_000 - 5000, 0, 5e9],
        preTokenBalances: [],
        postTokenBalances: [tb(1, USDC, W, '110')],
        keys: [W, 'UsdcAcct', OTHER],
      }),
      W,
    )!;
    expect(p.spent[0]).toMatchObject({ mint: SOL_MINT });
    expect(p.spent[0]!.amount).toBeGreaterThan(0.99);
    expect(p.spent[0]!.amount).toBeLessThan(1.01);
  });

  it('ignores a small SOL change (a tip) when the tokens already make the trade', () => {
    const p = parseSolanaTx(
      'sig5',
      tx({
        preBalances: [1_000_000_000, 2_039_280, 2_039_280, 5e9],
        postBalances: [1_000_000_000 - 5000 - 100_000, 2_039_280, 2_039_280, 5e9],
        preTokenBalances: [tb(1, ACT, W, '10')],
        postTokenBalances: [tb(1, ACT, W, '0'), tb(2, USDC, W, '1')],
      }),
      W,
    )!;
    expect(p.spent.map((l) => l.mint)).toEqual([ACT]);
  });

  it('reads a plain SOL receipt when the wallet did not pay the fee', () => {
    const p = parseSolanaTx('sig6', tx({ keys: [OTHER, W], preBalances: [5e9, 1e9], postBalances: [5e9 - 60_373_000 - 5000, 1e9 + 60_373_000] }), W)!;
    expect(p.gained).toHaveLength(1);
    expect(p.gained[0]!.mint).toBe(SOL_MINT);
    expect(p.gained[0]!.amount).toBeCloseTo(0.060373, 9);
    expect(p.spent).toEqual([]);
  });

  it('marks a failed transaction and reads nothing from it; gives null when the node has none', () => {
    const failed = parseSolanaTx('sig7', tx({ err: { InstructionError: [0, 'Custom'] } }), W)!;
    expect(failed.ok).toBe(false);
    expect(failed.gained).toEqual([]);
    expect(failed.spent).toEqual([]);
    expect(parseSolanaTx('sig8', null, W)).toBeNull();
  });
});

describe('classify', () => {
  const a = (mint: string, amount: number) => ({ mint, amount });
  it('a stablecoin is the money: paying USDC for a token is a buy, receiving it for a token is a sale', () => {
    expect(classify([a(ACT, 1000)], [a(USDC, 5)])).toMatchObject({ kind: 'bought', token: { mint: ACT }, quote: { mint: USDC } });
    expect(classify([a(USDC, 5)], [a(ACT, 1000)])).toMatchObject({ kind: 'sold', token: { mint: ACT }, quote: { mint: USDC } });
  });
  it('SOL is the money when no stablecoin is involved, and a token for SOL is a sale', () => {
    expect(classify([a(ACT, 1000)], [a(SOL_MINT, 0.05)])).toMatchObject({ kind: 'bought', token: { mint: ACT } });
    expect(classify([a(SOL_MINT, 0.05)], [a(ACT, 1000)])).toMatchObject({ kind: 'sold', token: { mint: ACT } });
  });
  it('SOL against USDC is a trade in SOL, with USDC as the money', () => {
    expect(classify([a(SOL_MINT, 1)], [a(USDC, 110)])).toMatchObject({ kind: 'bought', token: { mint: SOL_MINT } });
  });
  it('two tokens that are neither money, or two stablecoins, are a swap with no price', () => {
    expect(classify([a(ACT, 1)], [a('OtherMint1111111111111111111111111111111111', 2)]).kind).toBe('swapped');
    expect(classify([a(USDC, 5)], [a('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 5)]).kind).toBe('swapped');
  });
  it('one-sided changes are transfers and anything more complicated is shown as other, not forced into a trade', () => {
    expect(classify([a(SOL_MINT, 0.06)], []).kind).toBe('received');
    expect(classify([], [a(ACT, 5)]).kind).toBe('sent');
    expect(classify([a(ACT, 1), a(USDC, 1)], [a(SOL_MINT, 1)]).kind).toBe('other');
    expect(classify([], []).kind).toBe('other');
  });
});

describe('priceOf', () => {
  const sold = classify([{ mint: USDC, amount: 5.049636 }], [{ mint: ACT, amount: 1113.436513625 }]);
  it('a stablecoin side is already dollars: the price is that amount over the tokens', () => {
    const p = priceOf(sold, null);
    expect(p.usd).toBeCloseTo(0.0045352, 6);
    expect(p.valueUsd).toBeCloseTo(5.049636, 9);
  });
  it('a SOL side needs SOL’s dollar price; without it only the price in SOL is given', () => {
    const bought = classify([{ mint: ACT, amount: 1000 }], [{ mint: SOL_MINT, amount: 0.05 }]);
    expect(priceOf(bought, null)).toEqual({ usd: null, inQuote: 0.00005, valueUsd: null });
    const withSol = priceOf(bought, 120);
    expect(withSol.usd).toBeCloseTo(0.006, 9);
    expect(withSol.valueUsd).toBeCloseTo(6, 9);
  });
  it('a transfer or a swap has no price', () => {
    expect(priceOf(classify([{ mint: SOL_MINT, amount: 1 }], []), 100)).toEqual({ usd: null, inQuote: null, valueUsd: null });
  });
});

describe('SOL price at a time', () => {
  const candles = parseCandles([
    [7200, 102, 110, 100, 108, 5],
    [3600, 100, 105, 99, 102, 5],
    ['x', 1, 1, 1, 1, 1],
    [10800, 0, 0, 0, 0, 0],
  ]);
  it('drops rows that are not real prices and sorts oldest first', () => {
    expect(candles.map((c) => c.t)).toEqual([3600, 7200]);
  });
  it('puts the moment on the line from the candle’s open to its close', () => {
    expect(priceAt(candles, 3600)).toBeCloseTo(100, 9);
    expect(priceAt(candles, 5400)).toBeCloseTo(101, 9);
    expect(priceAt(candles, 7200)).toBeCloseTo(102, 9);
  });
  it('says nothing for a time the candles do not cover', () => {
    expect(priceAt(candles, 100)).toBeNull();
    expect(priceAt(candles, 99_999)).toBeNull();
    expect(priceAt([], 5000)).toBeNull();
  });
});

describe('summariseSwap', () => {
  it('paying a stablecoin for a token is a buy at a dollar price', () => {
    const s = summariseSwap('USDC', 'ACT', 5, 1000)!;
    expect(s.kind).toBe('bought');
    expect(s.token).toEqual({ symbol: 'ACT', amount: 1000 });
    expect(s.priceUsd).toBeCloseTo(0.005, 9);
  });
  it('a token for the network coin is a sale, priced in that coin', () => {
    const s = summariseSwap('ARK', 'BNB', 1000, 0.1)!;
    expect(s.kind).toBe('sold');
    expect(s.priceUsd).toBeNull();
    expect(s.priceInQuote).toBeCloseTo(0.0001, 9);
  });
  it('two like assets are a plain swap; unusable amounts give nothing', () => {
    expect(summariseSwap('USDC', 'USDT', 5, 5)!.kind).toBe('swapped');
    expect(summariseSwap('ACT', 'ARK', 5, 5)!.kind).toBe('swapped');
    expect(summariseSwap('USDC', 'ACT', 0, 5)).toBeNull();
    expect(summariseSwap('USDC', 'ACT', Number.NaN, 5)).toBeNull();
  });
});
