import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVM_ORDER_FORM,
  EVM_ORDERS_ADDRESSES,
  evmLimitPrice,
  evmOrderDisclosures,
  evmOrderTerms,
  evmOrdersChain,
  evmOrdersFlagOn,
  parseEvmOrder,
  previewEvmOrder,
  validateEvmOrder,
} from './walletOrdersEvmCore';

const addrs = { ethereum: { orders: '0x1111111111111111111111111111111111111111', fromBlock: 9 }, bnb: { orders: '0x4444444444444444444444444444444444444444', fromBlock: 1 } };

describe('where orders are', () => {
  it('nothing is deployed, so no chain has orders', () => {
    for (const k of ['ethereum', 'bnb', 'polygon']) {
      expect(EVM_ORDERS_ADDRESSES[k as 'ethereum']).toBeNull();
      expect(evmOrdersChain(k)).toBeNull();
    }
  });
  it('a chain with a contract offers its coin, USDC and USDT with the right decimals', () => {
    const eth = evmOrdersChain('ethereum', addrs)!;
    expect(eth.quotes.map((q) => [q.symbol, q.decimals, q.native])).toEqual([
      ['ETH', 18, true],
      ['USDC', 6, false],
      ['USDT', 6, false],
    ]);
    expect(eth.quotes[0]!.address).toBe(eth.wrapped);
    const bnb = evmOrdersChain('bnb', addrs)!;
    expect(bnb.quotes.map((q) => q.decimals)).toEqual([18, 18, 18]); // BNB Chain's stablecoins have 18 decimals
  });
  it('refuses a contract address that is not lower-case or not an address', () => {
    expect(evmOrdersChain('ethereum', { ethereum: { orders: '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD', fromBlock: 1 } })).toBeNull();
    expect(evmOrdersChain('ethereum', { ethereum: { orders: 'nope', fromBlock: 1 } })).toBeNull();
    expect(evmOrdersChain('nowhere', addrs)).toBeNull();
  });
  it('the flag is exactly "1"', () => {
    expect(evmOrdersFlagOn('1')).toBe(true);
    for (const v of [undefined, '', '0', 'true', ' 1']) expect(evmOrdersFlagOn(v)).toBe(false);
  });
});

describe('sizing an order', () => {
  const eth = evmOrdersChain('ethereum', addrs)!;
  const usdc = eth.quotes[1]!;
  const form = { ...DEFAULT_EVM_ORDER_FORM, token: '0x00000000000000000000000000000000000000b1', quote: 'USDC', amount: '100', price: '0.05' };

  it('rounds in the owner’s favour', () => {
    expect(evmOrderTerms(form, 18, usdc)).toMatchObject({ amountIn: 100_000_000n, priceQuote: 50_000n, minOut: 2000n * 10n ** 18n });
    expect(evmOrderTerms({ ...form, side: 'sell', amount: '2000' }, 18, usdc)).toMatchObject({ amountIn: 2000n * 10n ** 18n, minOut: 100_000_000n });
    expect(evmOrderTerms({ ...form, price: '0.0000001' }, 18, usdc)).toBeNull(); // more decimals than USDC has
    expect(evmOrderTerms({ ...form, amount: '0' }, 18, usdc)).toBeNull();
  });

  it('checks the minimum, the balance and whether the asset is on, in the asset’s own units', () => {
    const ctx = { tokenDecimals: 18, quote: usdc, minQuote: 50_000_000n, available: 1_000_000_000n };
    expect(validateEvmOrder(form, ctx)).toEqual([]);
    expect(validateEvmOrder({ ...form, amount: '10' }, ctx)[0]!.message).toBe('The smallest order is 50 USDC.');
    expect(validateEvmOrder({ ...form, amount: '5000' }, ctx)[0]!.message).toContain('not have enough');
    expect(validateEvmOrder(form, { ...ctx, minQuote: 0n })[0]!.message).toContain('not switched on');
    expect(validateEvmOrder({ ...form, token: 'x' }, null)[0]!.field).toBe('token');
  });

  it('tells the person the right assets and fees', () => {
    const t = evmOrderTerms(form, 18, usdc)!;
    expect(previewEvmOrder(t, 18, usdc)).toMatchObject({ escrowed: '100 USDC', fillFee: '1.5 USDC', cancelFee: '0.58 USDC' });
    const text = evmOrderDisclosures('buy', usdc, eth)
      .map((d) => d.text)
      .join(' ');
    expect(text).toContain('one pool of tokens');
    expect(text).toContain('1.5%');
    expect(text).toContain('Ethereum blockchain');
    expect(
      evmOrderDisclosures('buy', eth.quotes[0]!, eth)
        .map((d) => d.text)
        .join(' '),
    ).toContain('wrapped ETH');
    expect(
      evmOrderDisclosures('sell', eth.quotes[0]!, eth)
        .map((d) => d.text)
        .join(' '),
    ).toContain('paid in wrapped ETH');
  });
});

describe('reading an order', () => {
  const w = (n: bigint | string) => (typeof n === 'string' ? n.slice(2).padStart(64, '0') : n.toString(16).padStart(64, '0'));
  const ret = (over: Partial<Record<number, string>> = {}) => {
    const words = [
      w('0x00000000000000000000000000000000000000aa'),
      w('0x00000000000000000000000000000000000000b1'),
      w('0x00000000000000000000000000000000000000c1'),
      w(1n),
      w(58n),
      w(150n),
      w(200n),
      w(2000n),
      w(100n),
      w(60n),
      w(500n),
      w(40n),
      w(0n),
    ];
    for (const [i, v] of Object.entries(over)) words[Number(i)] = v!;
    return '0x' + words.join('');
  };
  it('parses a well-formed order', () => {
    expect(parseEvmOrder(3n, ret())).toMatchObject({ id: 3n, owner: '0x00000000000000000000000000000000000000aa', isBuy: true, cancelBps: 58, inTotal: 100n, inRemaining: 60n, minOutRemaining: 500n });
  });
  it('rejects a deleted order, a short answer, a bool that is not a bool and a dirty address', () => {
    expect(parseEvmOrder(3n, ret({ 0: w(0n) }))).toBeNull();
    expect(parseEvmOrder(3n, ret().slice(0, -64))).toBeNull();
    expect(parseEvmOrder(3n, ret({ 3: w(2n) }))).toBeNull();
    expect(parseEvmOrder(3n, ret({ 1: w('0x00000000000000000000000000000000000000b1').replace(/^0/, 'f') }))).toBeNull();
    expect(parseEvmOrder(3n, undefined)).toBeNull();
  });
  it('works out the price an order is waiting for', () => {
    expect(evmLimitPrice({ isBuy: true, inRemaining: 100_000_000n, minOutRemaining: 2000n * 10n ** 18n }, 18)).toBe(50_000n);
    expect(evmLimitPrice({ isBuy: false, inRemaining: 2000n * 10n ** 18n, minOutRemaining: 100_000_000n }, 18)).toBe(50_000n);
    expect(evmLimitPrice({ isBuy: true, inRemaining: 0n, minOutRemaining: 1n }, 18)).toBeNull();
  });
});
