import { describe, expect, it } from 'vitest';
import { lamportsToBalance, mergeBalances, parseTokenAccountsResult, splitByPrice, type RawBalance } from './walletHoldings';

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
