import * as web3 from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import orderFixture from './__fixtures__/orders/order.json';
import {
  QUOTE_SOL,
  QUOTE_USDC,
  QUOTE_USDT,
  quoteAssetsFor,
  quoteByMint,
  orderDisclosures as disclosuresFor,
  previewOrder as previewFor,
  validateOrder as validateFor,
  DEFAULT_ORDER_FORM,
  ORDERS_PROGRAM_ID_MAINNET,
  feeCeil,
  limitPrice,
  orderDisclosures,
  orderTerms,
  ordersFlagOn,
  ordersProgramFor,
  parseAssetAccount,
  parseOrderAccount,
  percentText,
  previewOrder,
  validateOrder,
  type OrderContext,
  type OrderForm,
} from './walletOrdersCore';
import { isSolanaAddress } from './walletTools';

const MINT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const form = (over: Partial<OrderForm> = {}): OrderForm => ({
  ...DEFAULT_ORDER_FORM,
  mint: MINT,
  side: 'buy',
  amount: '1',
  price: '0.00005',
  ...over,
});
const ctx = (over: Partial<OrderContext> = {}): OrderContext => ({
  decimals: 6,
  minQuote: 100_000_000n,
  available: 5_000_000_000n,
  ...over,
});
const keyOf = (bytes: Uint8Array) => new web3.PublicKey(bytes).toBase58();
const unhex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'));

describe('the switch', () => {
  it('is off unless the flag is exactly "1", and there is no mainnet program yet', () => {
    expect(ordersFlagOn('1')).toBe(true);
    for (const v of [undefined, '', '0', 'true', ' 1']) expect(ordersFlagOn(v)).toBe(false);
    expect(ORDERS_PROGRAM_ID_MAINNET).toBeNull();
    expect(ordersProgramFor('mainnet')).toBeNull();
  });
});

describe('orderTerms', () => {
  it('a buy at 0.00005 SOL per token: 1 SOL asks for at least 20,000 tokens', () => {
    const t = orderTerms(form(), 6)!;
    expect(t).toMatchObject({
      side: 'buy',
      amountIn: 1_000_000_000n,
      minOut: 20_000_000_000n,
      priceQuote: 50_000n,
    });
  });

  it('a sell at the same price: 20,000 tokens ask for at least 1 SOL', () => {
    const t = orderTerms(form({ side: 'sell', amount: '20000' }), 6)!;
    expect(t).toMatchObject({
      side: 'sell',
      amountIn: 20_000_000_000n,
      minOut: 1_000_000_000n,
    });
  });

  it('rounds up, so the order never asks for less than the price', () => {
    // 1 lamport at 3 lamports a token (6 decimals): 1e6 / 3 = 333,333.33 -> 333,334
    const t = orderTerms(form({ amount: '0.000000001', price: '0.000000003' }), 6)!;
    expect(t.minOut).toBe(333_334n);
  });

  it('refuses nonsense and anything that does not fit in 64 bits', () => {
    for (const bad of [{ amount: '0' }, { price: '0' }, { amount: '1.0000000001' }, { price: 'abc' }, { amount: '-1' }]) {
      expect(orderTerms(form(bad), 6)).toBeNull();
    }
    expect(orderTerms(form({ amount: '99999999999999999999', price: '0.000000001' }), 9)).toBeNull();
  });
});

describe('validateOrder', () => {
  it('passes a good order', () => {
    expect(validateOrder(form(), isSolanaAddress, ctx())).toEqual([]);
  });

  it('asks for what is missing before anything else', () => {
    const issues = validateOrder(form({ mint: 'x', price: '', amount: '' }), isSolanaAddress, null);
    expect(issues.map((i) => i.field)).toEqual(['mint', 'price', 'amount']);
  });

  it('enforces the smallest order, per side', () => {
    // A buy is measured by what it spends; 0.05 SOL is below 0.1.
    expect(validateOrder(form({ amount: '0.05' }), isSolanaAddress, ctx())[0]!.message).toContain('0.1 SOL');
    // A sell is measured by what it must bring in: 100 tokens x 0.0005 = 0.05 SOL.
    expect(validateOrder(form({ side: 'sell', amount: '100', price: '0.0005' }), isSolanaAddress, ctx({ available: 10n ** 12n }))[0]!.message).toContain('0.1 SOL');
  });

  it('refuses an order bigger than what the person has', () => {
    expect(validateOrder(form({ amount: '6' }), isSolanaAddress, ctx())).toEqual([{ field: 'amount', message: 'You do not have enough for this order.' }]);
  });
});

describe('what the person is told', () => {
  it('previews a buy in SOL and tokens, with the fee on each path', () => {
    const p = previewOrder(orderTerms(form(), 6)!, 6);
    expect(p).toEqual({
      escrowed: '1 SOL',
      atLeast: '20,000 tokens',
      fillFee: '0.015 SOL',
      cancelFee: '0.0058 SOL',
    });
  });

  it('previews a sell, with the cancel fee in the token', () => {
    const p = previewOrder(orderTerms(form({ side: 'sell', amount: '20000' }), 6)!, 6);
    expect(p).toEqual({
      escrowed: '20,000 tokens',
      atLeast: '1 SOL',
      fillFee: '0.02 SOL',
      cancelFee: '116 tokens',
    });
  });

  it('says the software is unaudited and the order is visible on chain, and names the exact fees', () => {
    const buy = orderDisclosures('buy')
      .map((d) => d.text)
      .join(' ');
    expect(buy).toContain('unaudited');
    expect(buy).toContain('visible on the Solana blockchain');
    expect(buy).toContain('1.5%');
    expect(buy).toContain('0.58%');
    expect(
      orderDisclosures('sell')
        .map((d) => d.text)
        .join(' '),
    ).toContain('2%');
  });

  it('shows the fee that is charged, never a rounded-down one', () => {
    expect(percentText(150n)).toBe('1.5%');
    expect(percentText(200n)).toBe('2%');
    expect(percentText(58n)).toBe('0.58%');
    expect(
      orderDisclosures('buy')
        .map((d) => d.text)
        .join(' '),
    ).not.toContain('1% of');
  });

  it('fees round up', () => {
    expect(feeCeil(1n, 150n)).toBe(1n);
    expect(feeCeil(10_000n, 150n)).toBe(150n);
  });
});

describe('reading the program’s accounts (a real account written by the compiled program)', () => {
  const g = orderFixture;

  it('reads a fresh order', () => {
    const o = parseOrderAccount(keyOf, unhex(g.createdDataHex))!;
    expect(o).toMatchObject({
      owner: g.owner,
      launchMint: g.launchMint,
      quoteMint: g.quoteMint,
      side: 'buy',
      nonce: 7n,
      inTotal: 1_000_000_000n,
      inRemaining: 1_000_000_000n,
      minOutRemaining: 500_000_000n,
      cancelFeeBps: 58,
      status: 1,
    });
  });

  it('reads an order after a partial fill', () => {
    const o = parseOrderAccount(keyOf, unhex(g.afterFillDataHex))!;
    expect(o.inRemaining).toBe(600_000_000n);
    expect(o.feePaid).toBe(6_000_000n);
  });

  it('refuses anything that is not exactly an order', () => {
    const d = unhex(g.createdDataHex);
    expect(parseOrderAccount(keyOf, d.subarray(1))).toBeNull();
    const wrong = d.slice();
    wrong[0] = wrong[0]! ^ 1;
    expect(parseOrderAccount(keyOf, wrong)).toBeNull();
    const badSide = d.slice();
    badSide[8 + 160] = 7;
    expect(parseOrderAccount(keyOf, badSide)).toBeNull();
  });

  it('shows the price an order is waiting for', () => {
    const o = parseOrderAccount(keyOf, unhex(g.createdDataHex))!;
    // 1,000,000,000 lamports in for 500,000,000 base units (500 tokens at 6 decimals): 2,000,000 lamports (0.002 SOL) a token.
    expect(limitPrice(o, 6)).toBe(2_000_000n);
    expect(limitPrice({ ...o, inRemaining: 0n }, 6)).toBeNull();
  });

  it('reads an asset account', () => {
    const data = new Uint8Array(8 + 32 + 8 + 1 + 1);
    new DataView(data.buffer).setBigUint64(40, 100_000_000n, true);
    data[48] = 1;
    expect(parseAssetAccount(keyOf, data)).toMatchObject({
      minAmount: 100_000_000n,
      enabled: true,
    });
    expect(parseAssetAccount(keyOf, data.subarray(1))).toBeNull();
  });
});

describe('payment assets', () => {
  it('mainnet offers SOL, USDC and USDT; devnet only SOL (the stablecoin mints are mainnet’s)', () => {
    expect(quoteAssetsFor('mainnet').map((q) => q.symbol)).toEqual(['SOL', 'USDC', 'USDT']);
    expect(quoteAssetsFor('devnet').map((q) => q.symbol)).toEqual(['SOL']);
    expect(quoteByMint(QUOTE_USDC.mint)).toBe(QUOTE_USDC);
    expect(quoteByMint('11111111111111111111111111111111')).toBeNull();
  });

  it('sizes a USDC order with six decimals and rounds in the owner’s favour', () => {
    const form = { ...DEFAULT_ORDER_FORM, mint: 'x', side: 'buy' as const, amount: '100', price: '0.05', quote: 'USDC' as const };
    expect(orderTerms(form, 6, QUOTE_USDC)).toMatchObject({ amountIn: 100_000_000n, priceQuote: 50_000n, minOut: 2_000_000_000n });
    expect(orderTerms({ ...form, price: '0.0000001' }, 6, QUOTE_USDC)).toBeNull(); // more than six decimals
    expect(orderTerms({ ...form, side: 'sell', amount: '2000', price: '0.05' }, 6, QUOTE_USDT)).toMatchObject({ amountIn: 2_000_000_000n, minOut: 100_000_000n });
  });

  it('says USDC, not SOL, in what the person is told', () => {
    const terms = orderTerms({ ...DEFAULT_ORDER_FORM, mint: 'x', amount: '100', price: '0.05', quote: 'USDC' }, 6, QUOTE_USDC)!;
    expect(previewFor(terms, 6, QUOTE_USDC)).toMatchObject({ escrowed: '100 USDC', fillFee: '1.5 USDC', cancelFee: '0.58 USDC' });
    const text = disclosuresFor('buy', QUOTE_USDC)
      .map((d) => d.text)
      .join(' ');
    expect(text).toContain('USDC');
    expect(text).not.toContain('wrapped SOL');
    expect(text).toContain('Meteora pool');
    expect(
      disclosuresFor('buy', QUOTE_SOL)
        .map((d) => d.text)
        .join(' '),
    ).toContain('wrapped SOL');
  });

  it('checks the minimum in the asset’s own units', () => {
    const form = { ...DEFAULT_ORDER_FORM, mint: 'x', amount: '10', price: '0.05', quote: 'USDC' as const };
    const issues = validateFor(form, () => true, { decimals: 6, minQuote: 50_000_000n, available: 1_000_000_000n, quote: QUOTE_USDC });
    expect(issues[0]?.message).toBe('The smallest order is 50 USDC.');
  });
});
