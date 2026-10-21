import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/ordersEvm/calldata.json';
import type { EvmTxRequest } from '../swings/chains/evmWallet.js';
import { evmOrdersChain } from './walletOrdersEvmCore';
import {
  ORDERS_SEL,
  ORDER_CREATED_TOPIC,
  buildCancelOrderTx,
  buildCreateNativeBuyTx,
  buildCreateOrderTx,
  buildOrderApproveTx,
  decodeCancelOrder,
  decodeCreateOrder,
  inspectCancelOrder,
  inspectCreateOrder,
  inspectOrderApprove,
} from './walletOrdersEvmTx';

const ORDERS = '0x1111111111111111111111111111111111111111';
const chain = evmOrdersChain('ethereum', { ethereum: { orders: ORDERS, fromBlock: 5 } })!;
const ME = '0x00000000000000000000000000000000000000aa';
const L = fixture.launchToken;
const Q = fixture.quoteToken;

describe('calldata matches the real contract', () => {
  it('createOrder (buy and sell), createBuyWithNative and cancel are byte for byte what the compiled ABI encodes', () => {
    expect(buildCreateOrderTx(ME, chain, { launchToken: L, quoteToken: Q, isBuy: true, amountIn: 100_000_000n, minOut: 2_000_000_000_000_000_000n }).data).toBe(fixture.createOrderBuy);
    expect(buildCreateOrderTx(ME, chain, { launchToken: L, quoteToken: Q, isBuy: false, amountIn: 5_000_000_000_000_000_000n, minOut: 90_000_000n }).data).toBe(fixture.createOrderSell);
    expect(buildCreateNativeBuyTx(ME, chain, { launchToken: L, wei: 1n, minOut: 123456789n }).data).toBe(fixture.createBuyWithNative);
    expect(buildCancelOrderTx(ME, chain, 42n).data).toBe(fixture.cancel);
  });
  it('selectors and the creation event topic match', () => {
    expect(ORDERS_SEL.orders).toBe(fixture.selectors.orders);
    expect(ORDERS_SEL.minAmount).toBe(fixture.selectors.minAmount);
    expect(ORDER_CREATED_TOPIC).toBe(fixture.orderCreatedTopic);
  });
  it('decodes what it builds, and nothing else', () => {
    expect(decodeCreateOrder(fixture.createOrderBuy)).toEqual({ launchToken: L, quoteToken: Q, isBuy: true, amountIn: 100_000_000n, minOut: 2_000_000_000_000_000_000n });
    expect(decodeCancelOrder(fixture.cancel)).toBe(42n);
    expect(decodeCreateOrder(fixture.createOrderBuy + '00')).toBeNull();
    expect(decodeCreateOrder(fixture.createOrderBuy.slice(0, -64) + 'f'.repeat(64) + '')).not.toBeNull(); // amounts are checked by the inspector, not the decoder
    expect(decodeCreateOrder(fixture.createOrderBuy.replace(fixture.createOrderBuy.slice(2 + 8 + 64 * 2, 2 + 8 + 64 * 3), '0'.repeat(63) + '2'))).toBeNull(); // a bool that is not 0 or 1
    expect(decodeCancelOrder('0xdeadbeef')).toBeNull();
  });
});

describe('the check before signing', () => {
  const buy = { chain, from: ME, launchToken: L, quoteToken: Q, isBuy: true, amountIn: 100_000_000n, minOut: 2_000_000_000_000_000_000n, native: false };
  const good = (): EvmTxRequest => buildCreateOrderTx(ME, chain, buy);

  it('passes exactly what was approved', () => {
    expect(inspectCreateOrder(good(), buy, 1)).toEqual([]);
    expect(inspectOrderApprove(buildOrderApproveTx(ME, Q, chain, 100_000_000n), { chain, from: ME, token: Q, amount: 100_000_000n }, 1)).toEqual([]);
    expect(inspectCancelOrder(buildCancelOrderTx(ME, chain, 7n), { chain, from: ME, id: 7n }, 1)).toEqual([]);
    const native = { ...buy, native: true, quoteToken: chain.wrapped, amountIn: 10n ** 18n };
    expect(inspectCreateOrder(buildCreateNativeBuyTx(ME, chain, { launchToken: L, wei: 10n ** 18n, minOut: buy.minOut }), native, 1)).toEqual([]);
  });

  it.each([
    ['another contract', (t: EvmTxRequest) => ({ ...t, to: '0x2222222222222222222222222222222222222222' }), 'not sent to the Aretia orders contract'],
    ['another account', (t: EvmTxRequest) => ({ ...t, from: '0x00000000000000000000000000000000000000bb' }), 'not from the account'],
    ['coins attached', (t: EvmTxRequest) => ({ ...t, value: '0x1' }), 'carries coins'],
    ['another network', (t: EvmTxRequest) => ({ ...t, chainId: '0x38' }), 'not bound'],
    ['an extra field', (t: EvmTxRequest) => ({ ...t, nonce: '0x1' }) as EvmTxRequest, 'unexpected field'],
    ['a different payment asset', (t: EvmTxRequest) => ({ ...t, data: (t.data ?? '').replace(Q.slice(2), '00000000000000000000000000000000000000d1') }), 'different asset'],
    ['a different amount', (t: EvmTxRequest) => ({ ...t, data: (t.data ?? '').slice(0, -128) + '0'.repeat(63) + '9' + (t.data ?? '').slice(-64) }), 'escrow is not the one shown'],
    ['a softer price', (t: EvmTxRequest) => ({ ...t, data: (t.data ?? '').slice(0, -64) + '0'.repeat(63) + '1' }), 'least you would accept'],
    ['another function', (t: EvmTxRequest) => ({ ...t, data: fixture.cancel }), 'not a plain order'],
  ])('refuses %s', (_name, tamper, words) => {
    expect(inspectCreateOrder(tamper(good()), buy, 1).join(' ')).toContain(words);
  });

  it('refuses a wallet on the wrong network', () => {
    expect(inspectCreateOrder(good(), buy, 56).join(' ')).toContain('wallet is on network 56');
  });

  it('refuses an approval to anyone but the orders contract, or for more than the order', () => {
    const c = { chain, from: ME, token: Q, amount: 100_000_000n };
    const other = buildOrderApproveTx(ME, Q, { ...chain, orders: '0x3333333333333333333333333333333333333333' }, 100_000_000n);
    expect(inspectOrderApprove(other, c, 1).join(' ')).toContain('someone other than the Aretia orders contract');
    expect(inspectOrderApprove(buildOrderApproveTx(ME, Q, chain, 2n ** 256n - 1n), c, 1).join(' ')).toContain('different amount');
    expect(inspectOrderApprove(buildOrderApproveTx(ME, L, chain, 100_000_000n), c, 1).join(' ')).toContain('not sent to the token you chose');
  });

  it('a coin-paid order must carry exactly the coin shown and be a buy against the wrapped coin', () => {
    const native = { ...buy, native: true, quoteToken: chain.wrapped, amountIn: 10n ** 18n };
    const tx = buildCreateNativeBuyTx(ME, chain, { launchToken: L, wei: 10n ** 18n, minOut: buy.minOut });
    expect(inspectCreateOrder({ ...tx, value: '0x1' }, native, 1).join(' ')).toContain('coins sent are not exactly');
    expect(inspectCreateOrder(tx, { ...native, isBuy: false }, 1).join(' ')).toContain('Only a buy');
    expect(inspectCreateOrder(tx, { ...native, quoteToken: Q }, 1).join(' ')).toContain('wrapped coin');
  });

  it('a cancel must name the chosen order and carry nothing', () => {
    expect(inspectCancelOrder(buildCancelOrderTx(ME, chain, 8n), { chain, from: ME, id: 7n }, 1).join(' ')).toContain('different order');
    expect(inspectCancelOrder({ ...buildCancelOrderTx(ME, chain, 7n), value: '0x5' }, { chain, from: ME, id: 7n }, 1).join(' ')).toContain('carries coins');
  });
});
