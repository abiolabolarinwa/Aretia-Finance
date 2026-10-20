import { describe, expect, it } from 'vitest';
import { countsTowardTotal, dexScreenerPrices, portfolioTotal, lamportsToBalance, mergeBalances, parseTokenAccountsResult, priceWithLiquidity, splitByPrice, type RawBalance } from './walletHoldings';

const SOL = 'So11111111111111111111111111111111111111112';
const account = (mint: unknown, amount: unknown, decimals: unknown, ui?: unknown) => ({
  pubkey: 'x',
  account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals, uiAmountString: ui } } } } },
});
const balance = (mint: string, amount: number, extra: Partial<RawBalance> = {}): RawBalance => ({ mint, amount, raw: null, decimals: null, ...extra });

describe('parseTokenAccountsResult', () => {
  it('reads each token account into a balance with its exact amount and decimals', () => {
    const out = parseTokenAccountsResult({ value: [account('MintA', '1500000', 6, '1.5')] });
    expect(out).toEqual([{ mint: 'MintA', amount: 1.5, raw: '1500000', decimals: 6 }]);
  });

  it('adds together several token accounts for the same mint', () => {
    const out = parseTokenAccountsResult({ value: [account('MintA', '1000000', 6, '1'), account('MintA', '2500000', 6, '2.5'), account('MintB', '7', 0, '7')] });
    expect(out.find((b) => b.mint === 'MintA')).toEqual({ mint: 'MintA', amount: 3.5, raw: '3500000', decimals: 6 });
    expect(out).toHaveLength(2);
  });

  it('leaves out empty accounts', () => {
    expect(parseTokenAccountsResult({ value: [account('MintA', '0', 6, '0')] })).toEqual([]);
  });

  it('keeps the exact amount of a huge balance', () => {
    const big = '123456789012345678901234567890';
    expect(parseTokenAccountsResult({ value: [account('MintA', big, 9, '123456789012345678901.23456789')] })[0]!.raw).toBe(big);
  });

  it.each([
    ['a missing mint', account(undefined, '5', 6, '5')],
    ['a non-numeric amount', account('MintA', 'lots', 6, '5')],
    ['missing decimals', account('MintA', '5', undefined, '5')],
    ['not an account at all', null],
    ['an empty object', {}],
  ])('skips %s without failing the others', (_name, bad) => {
    const out = parseTokenAccountsResult({ value: [bad, account('Good', '3', 0, '3')] });
    expect(out.map((b) => b.mint)).toEqual(['Good']);
  });

  it('returns nothing for an answer that is not a list', () => {
    for (const result of [null, undefined, {}, { value: null }, { value: 'x' }, 5]) expect(parseTokenAccountsResult(result)).toEqual([]);
  });
});

describe('lamportsToBalance', () => {
  it('turns lamports into a SOL balance', () => {
    expect(lamportsToBalance(SOL, 2_500_000_000)).toEqual({ mint: SOL, amount: 2.5, raw: '2500000000', decimals: 9 });
  });
  it('gives nothing for zero or a bad value', () => {
    for (const v of [0, -1, Number.NaN, '5', null, undefined]) expect(lamportsToBalance(SOL, v)).toBeNull();
  });
});

describe('mergeBalances', () => {
  it('adds the tokens only the chain read found, after Jupiter\'s own', () => {
    const merged = mergeBalances([balance(SOL, 1), balance('A', 5)], [balance('A', 5), balance('B', 9, { decimals: 6 })]);
    expect(merged.map((b) => b.mint)).toEqual([SOL, 'A', 'B']);
  });

  it('keeps tokens only Jupiter knew (for example when the chain read failed)', () => {
    expect(mergeBalances([balance('A', 5)], []).map((b) => b.mint)).toEqual(['A']);
  });

  it('works when Jupiter gave nothing', () => {
    expect(mergeBalances([], [balance('B', 9)]).map((b) => b.mint)).toEqual(['B']);
  });

  it('takes the larger amount when both know a mint, and fills in missing decimals', () => {
    const merged = mergeBalances([balance('A', 5)], [balance('A', 8, { raw: '8000000', decimals: 6 })]);
    expect(merged).toEqual([{ mint: 'A', amount: 8, raw: '8000000', decimals: 6 }]);
    const kept = mergeBalances([balance('A', 9, { raw: '9' })], [balance('A', 8, { decimals: 6 })]);
    expect(kept[0]).toMatchObject({ amount: 9, raw: '9', decimals: 6 });
  });
});

describe('splitByPrice', () => {
  const h = (mint: string, value: number | null) => ({ mint, value });
  const list = [h(SOL, null), h('ACT', 5), h('SPAM1', null), h('SPAM2', null)];

  it('hides tokens with no price, but never the native coin', () => {
    const { shown, hiddenUnpriced } = splitByPrice(list, SOL, false);
    expect(shown.map((x) => x.mint)).toEqual([SOL, 'ACT']);
    expect(hiddenUnpriced.map((x) => x.mint)).toEqual(['SPAM1', 'SPAM2']);
  });

  it('shows everything when asked', () => {
    const { shown, hiddenUnpriced } = splitByPrice(list, SOL, true);
    expect(shown).toHaveLength(4);
    expect(hiddenUnpriced).toEqual([]);
  });

  it('hides nothing when no holding has a price, since that means the price feeds are down', () => {
    const none = [h(SOL, null), h('A', null)];
    expect(splitByPrice(none, SOL, false)).toEqual({ shown: none, hiddenUnpriced: [] });
  });

  it('keeps the original order', () => {
    expect(splitByPrice([h('B', 1), h('A', 2), h(SOL, 3)], SOL, false).shown.map((x) => x.mint)).toEqual(['B', 'A', SOL]);
  });
});

describe('holding prices carry the pool behind them (audit M-8, L-29)', () => {
  const WSOL = 'So11111111111111111111111111111111111111112';
  const majors = new Set([WSOL.toLowerCase()]);
  const SPAM = 'SpamSpamSpamSpamSpamSpamSpamSpamSpamSpam111';

  it('takes the SOL-paired pool over a deeper pool against a made-up token when it holds 5% of it; otherwise the price is thin', () => {
    const fake = { baseToken: { address: SPAM }, quoteToken: { address: 'FakeQuote1111111111111111111111111111111111' }, priceUsd: '500', liquidity: { usd: 900_000 } };
    expect(dexScreenerPrices([fake, { baseToken: { address: SPAM }, quoteToken: { address: WSOL }, priceUsd: '0.01', liquidity: { usd: 50_000 } }], majors).get(SPAM)).toEqual({ price: 0.01, thin: false });
    // A claimed $90M against a $50K real pool: the claimed one is drawn but thin, so it is never added to the total.
    expect(dexScreenerPrices([{ ...fake, liquidity: { usd: 90_000_000 } }, { baseToken: { address: SPAM }, quoteToken: { address: WSOL }, priceUsd: '0.01', liquidity: { usd: 50_000 } }], majors).get(SPAM)).toEqual({ price: 500, thin: true });
  });

  it('a $3 WSOL pool does not set the price of a token with a $2M JUP pool, and that price is marked thin (re-audit M-8)', () => {
    const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
    const got = dexScreenerPrices([
      { baseToken: { address: SPAM }, quoteToken: { address: WSOL }, priceUsd: '9', liquidity: { usd: 3 } },
      { baseToken: { address: SPAM }, quoteToken: { address: JUP }, priceUsd: '0.42', liquidity: { usd: 2_000_000 } },
    ], majors);
    expect(got.get(SPAM)).toEqual({ price: 0.42, thin: true });
  });

  it('a price from a pool against an unknown token is thin; one from a dust pool gives no value at all', () => {
    expect(dexScreenerPrices([{ baseToken: { address: SPAM }, quoteToken: { address: 'FakeQuote1111111111111111111111111111111111' }, priceUsd: '500', liquidity: { usd: 90_000_000 } }], majors).get(SPAM)).toEqual({ price: 500, thin: true });
    expect(dexScreenerPrices([{ baseToken: { address: SPAM }, quoteToken: { address: WSOL }, priceUsd: '500', liquidity: { usd: 20 } }], majors).has(SPAM)).toBe(false);
  });

  it('Jupiter and GeckoTerminal prices are marked thin by their liquidity too', () => {
    expect(priceWithLiquidity(3, null)).toEqual({ price: 3, thin: true });
    expect(priceWithLiquidity(3, 5_000)).toEqual({ price: 3, thin: true });
    expect(priceWithLiquidity(3, 2_000_000)).toEqual({ price: 3, thin: false });
    expect(priceWithLiquidity(3, 999)).toBeNull();
    expect(priceWithLiquidity(0, 2_000_000)).toBeNull();
  });
});

describe('the portfolio total leaves thin prices out (re-audit L-29)', () => {
  it('adds only holdings with a solid price; thin or non-major-priced ones are shown but not counted', () => {
    const rows = [
      { mint: 'SOL', value: 150, thin: false },
      { mint: 'USDC', value: 50, thin: false },
      // An airdropped token priced from a pool against an unknown quote: marked thin, so not added.
      { mint: 'SPAM', value: 9_000_000, thin: true },
      { mint: 'NOPRICE', value: null, thin: false },
    ];
    expect(portfolioTotal(rows)).toEqual({ sum: 200, counted: 2, thinLeftOut: 1 });
    expect(countsTowardTotal(rows[2]!)).toBe(false);
    expect(countsTowardTotal(rows[3]!)).toBe(false);
    expect(portfolioTotal([])).toEqual({ sum: 0, counted: 0, thinLeftOut: 0 });
  });
  it('a dexScreener price from a pool not paired with a major token never reaches the total', () => {
    const SPAM = 'SpamSpamSpamSpamSpamSpamSpamSpamSpamSpam111';
    const p = dexScreenerPrices([{ baseToken: { address: SPAM }, quoteToken: { address: 'FakeQuote1111111111111111111111111111111111' }, priceUsd: '500', liquidity: { usd: 90_000_000 } }], new Set())!.get(SPAM)!;
    expect(portfolioTotal([{ value: 1_000 * p.price, thin: p.thin }]).sum).toBe(0);
  });
});
