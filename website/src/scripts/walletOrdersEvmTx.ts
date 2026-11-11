/**
 * Limit orders on Ethereum-style chains: the transactions, and the independent check of each before anyone signs.
 *
 * The inspectors decode the transaction they are given from its bytes and compare every part with what the person approved. They do not
 * call the builders. The flow runs them on the exact objects it hands to the wallet. The contract address comes from a constant
 * (walletOrdersEvmCore.ts), never from the page or the chain. The calldata is checked against the real contract's ABI in
 * __fixtures__/ordersEvm/calldata.json.
 */
import { keccak256 } from '../swings/core/keccak.js';
import type { EvmTxRequest } from '../swings/chains/evmWallet.js';
import { toHexQuantity } from './walletLaunchEvmTx';
import { APPROVE_SELECTOR, decodeApprove, encodeApprove } from './walletPoolEvmTx';
import type { EvmOrdersChain } from './walletOrdersEvmCore';

const enc = new TextEncoder();
const selectorOf = (signature: string): string =>
  '0x' +
  [...keccak256(enc.encode(signature))]
    .slice(0, 4)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
const topicOf = (signature: string): string => '0x' + [...keccak256(enc.encode(signature))].map((x) => x.toString(16).padStart(2, '0')).join('');
const word = (n: bigint): string => {
  if (n < 0n || n >= 1n << 256n) throw new Error('A number does not fit in 256 bits.');
  return n.toString(16).padStart(64, '0');
};
const addrWord = (a: string): string => a.slice(2).toLowerCase().padStart(64, '0');

export const ORDERS_SEL = {
  createOrder: selectorOf('createOrder(address,address,bool,uint256,uint256)'),
  createBuyWithNative: selectorOf('createBuyWithNative(address,uint256)'),
  cancel: selectorOf('cancel(uint256)'),
  orders: selectorOf('orders(uint256)'),
  minAmount: selectorOf('minAmount(address)'),
  proveLaunchToken: selectorOf('proveLaunchToken(address,uint256)'),
  proven: selectorOf('proven(address)'),
} as const;
export const ORDER_CREATED_TOPIC = topicOf('OrderCreated(uint256,address,address,address,bool,uint256,uint256)');

const chainHex = (id: number): string => '0x' + id.toString(16);

// ---------------------------------------------------------------- builders

export const buildOrderApproveTx = (from: string, token: string, chain: EvmOrdersChain, amount: bigint): EvmTxRequest => ({
  from,
  to: token,
  data: encodeApprove(chain.orders, amount),
  value: '0x0',
  chainId: chainHex(chain.chainId),
});

export const buildCreateOrderTx = (from: string, chain: EvmOrdersChain, a: { launchToken: string; quoteToken: string; isBuy: boolean; amountIn: bigint; minOut: bigint }): EvmTxRequest => ({
  from,
  to: chain.orders,
  data: ORDERS_SEL.createOrder + addrWord(a.launchToken) + addrWord(a.quoteToken) + word(a.isBuy ? 1n : 0n) + word(a.amountIn) + word(a.minOut),
  value: '0x0',
  chainId: chainHex(chain.chainId),
});

/** A buy paid in the chain's coin: the coin travels with the call and the contract wraps it. */
export const buildCreateNativeBuyTx = (from: string, chain: EvmOrdersChain, a: { launchToken: string; wei: bigint; minOut: bigint }): EvmTxRequest => ({
  from,
  to: chain.orders,
  data: ORDERS_SEL.createBuyWithNative + addrWord(a.launchToken) + word(a.minOut),
  value: toHexQuantity(a.wei),
  chainId: chainHex(chain.chainId),
});

export const buildCancelOrderTx = (from: string, chain: EvmOrdersChain, id: bigint): EvmTxRequest => ({
  from,
  to: chain.orders,
  data: ORDERS_SEL.cancel + word(id),
  value: '0x0',
  chainId: chainHex(chain.chainId),
});

export const orderReadData = (id: bigint): string => ORDERS_SEL.orders + word(id);
export const buildProveTx = (from: string, chain: EvmOrdersChain, token: string, factoryNonce: bigint): EvmTxRequest => ({
  from,
  to: chain.orders,
  data: ORDERS_SEL.proveLaunchToken + addrWord(token) + word(factoryNonce),
  value: '0x0',
  chainId: chainHex(chain.chainId),
});
export const provenReadData = (token: string): string => ORDERS_SEL.proven + addrWord(token);
export const minAmountReadData = (quote: string): string => ORDERS_SEL.minAmount + addrWord(quote);

// ---------------------------------------------------------------- decoding

const words = (data: string, selector: string, count: number): string[] | null => {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data) || !data.toLowerCase().startsWith(selector) || data.length !== 10 + count * 64) return null;
  return Array.from({ length: count }, (_, i) => data.slice(10 + i * 64, 10 + (i + 1) * 64).toLowerCase());
};
const asAddr = (w: string): string | null => (/^0{24}[0-9a-f]{40}$/.test(w) ? '0x' + w.slice(24) : null);
const big = (w: string): bigint => BigInt('0x' + w);

export const decodeCreateOrder = (data: string): { launchToken: string; quoteToken: string; isBuy: boolean; amountIn: bigint; minOut: bigint } | null => {
  const w = words(data, ORDERS_SEL.createOrder, 5);
  const launchToken = w ? asAddr(w[0]!) : null;
  const quoteToken = w ? asAddr(w[1]!) : null;
  if (!w || !launchToken || !quoteToken || big(w[2]!) > 1n) return null;
  return { launchToken, quoteToken, isBuy: big(w[2]!) === 1n, amountIn: big(w[3]!), minOut: big(w[4]!) };
};
export const decodeCreateNativeBuy = (data: string): { launchToken: string; minOut: bigint } | null => {
  const w = words(data, ORDERS_SEL.createBuyWithNative, 2);
  const launchToken = w ? asAddr(w[0]!) : null;
  return w && launchToken ? { launchToken, minOut: big(w[1]!) } : null;
};
export const decodeProve = (data: string): { token: string; factoryNonce: bigint } | null => {
  const w = words(data, ORDERS_SEL.proveLaunchToken, 2);
  const token = w ? asAddr(w[0]!) : null;
  return w && token ? { token, factoryNonce: big(w[1]!) } : null;
};
export const decodeCancelOrder = (data: string): bigint | null => {
  const w = words(data, ORDERS_SEL.cancel, 1);
  return w ? big(w[0]!) : null;
};

// ---------------------------------------------------------------- the check before signing

const ALLOWED = new Set(['from', 'to', 'data', 'value', 'gas', 'chainId']);
const valueOf = (tx: EvmTxRequest): bigint | null => (typeof tx.value === 'string' && /^0x[0-9a-fA-F]+$/.test(tx.value) ? BigInt(tx.value) : null);
const toIs = (tx: EvmTxRequest, address: string): boolean => typeof tx.to === 'string' && tx.to.toLowerCase() === address.toLowerCase();

function common(tx: EvmTxRequest, chain: EvmOrdersChain, from: string, walletChainId: number): string[] {
  const p: string[] = [];
  if (walletChainId !== chain.chainId) p.push(`The wallet is on network ${walletChainId}, not ${chain.name} (${chain.chainId}).`);
  if (tx.chainId !== chainHex(chain.chainId)) p.push(`The transaction is not bound to ${chain.name} (chain id ${chain.chainId}).`);
  for (const k of Object.keys(tx)) if (!ALLOWED.has(k)) p.push(`The transaction has an unexpected field (${k}).`);
  if (typeof tx.from !== 'string' || tx.from.toLowerCase() !== from.toLowerCase()) p.push('The transaction is not from the account you approved.');
  if (tx.gas !== undefined && !(typeof tx.gas === 'string' && /^0x[0-9a-fA-F]+$/.test(tx.gas) && BigInt(tx.gas) > 0n)) p.push('The gas limit is not a number.');
  return p;
}

/** The approval must go to the escrow token, name the ORDERS CONTRACT as spender (never anyone else), be for exactly the amount (never unlimited), and carry no coin. */
export function inspectOrderApprove(tx: EvmTxRequest, c: { chain: EvmOrdersChain; from: string; token: string; amount: bigint }, walletChainId: number): string[] {
  const p = common(tx, c.chain, c.from, walletChainId);
  if (!toIs(tx, c.token)) p.push('The approval is not sent to the token you chose.');
  if (valueOf(tx) !== 0n) p.push('The approval carries coins, which it should not.');
  const d = typeof tx.data === 'string' && tx.data.toLowerCase().startsWith(APPROVE_SELECTOR) ? decodeApprove(tx.data) : null;
  if (!d) p.push('The transaction data is not a plain approval.');
  else {
    if (d.spender !== c.chain.orders) p.push('The approval names someone other than the Aretia orders contract.');
    if (d.amount !== c.amount) p.push('The approval is for a different amount than you approved.');
  }
  return p;
}

export interface CreateOrderCheck {
  chain: EvmOrdersChain;
  from: string;
  launchToken: string;
  quoteToken: string;
  isBuy: boolean;
  amountIn: bigint;
  minOut: bigint;
  /** A buy paid in the chain's coin. */
  native: boolean;
}

export function inspectCreateOrder(tx: EvmTxRequest, c: CreateOrderCheck, walletChainId: number): string[] {
  const p = common(tx, c.chain, c.from, walletChainId);
  if (!toIs(tx, c.chain.orders)) p.push('The transaction is not sent to the Aretia orders contract for this network.');
  if (c.native) {
    if (!c.isBuy) p.push('Only a buy can be paid in the chain’s coin.');
    if (valueOf(tx) !== c.amountIn) p.push('The coins sent are not exactly the amount shown.');
    if (c.quoteToken.toLowerCase() !== c.chain.wrapped) p.push('A coin-paid order must be against the wrapped coin.');
    const d = typeof tx.data === 'string' ? decodeCreateNativeBuy(tx.data) : null;
    if (!d) p.push('The transaction data is not a plain coin-paid buy.');
    else {
      if (d.launchToken !== c.launchToken.toLowerCase()) p.push('The order is for a different token than you chose.');
      if (d.minOut !== c.minOut) p.push('The least you would accept is not the one shown.');
    }
    return p;
  }
  if (valueOf(tx) !== 0n) p.push('The order carries coins, which it should not.');
  const d = typeof tx.data === 'string' ? decodeCreateOrder(tx.data) : null;
  if (!d) p.push('The transaction data is not a plain order.');
  else {
    if (d.launchToken !== c.launchToken.toLowerCase()) p.push('The order is for a different token than you chose.');
    if (d.quoteToken !== c.quoteToken.toLowerCase()) p.push('The order is paid in a different asset than you chose.');
    if (d.isBuy !== c.isBuy) p.push('The order is on the wrong side.');
    if (d.amountIn !== c.amountIn) p.push('The amount held in escrow is not the one shown.');
    if (d.minOut !== c.minOut) p.push('The least you would accept is not the one shown.');
  }
  return p;
}

export function inspectCancelOrder(tx: EvmTxRequest, c: { chain: EvmOrdersChain; from: string; id: bigint }, walletChainId: number): string[] {
  const p = common(tx, c.chain, c.from, walletChainId);
  if (!toIs(tx, c.chain.orders)) p.push('The transaction is not sent to the Aretia orders contract for this network.');
  if (valueOf(tx) !== 0n) p.push('A cancel carries coins, which it should not.');
  const id = typeof tx.data === 'string' ? decodeCancelOrder(tx.data) : null;
  if (id === null) p.push('The transaction data is not a plain cancel.');
  else if (id !== c.id) p.push('The cancel is for a different order than you chose.');
  return p;
}

/** The one-time proof: sent to the orders contract, naming the token and the factory nonce worked out for it, and carrying nothing. */
export function inspectProve(tx: EvmTxRequest, c: { chain: EvmOrdersChain; from: string; token: string; factoryNonce: bigint }, walletChainId: number): string[] {
  const p = common(tx, c.chain, c.from, walletChainId);
  if (!toIs(tx, c.chain.orders)) p.push('The transaction is not sent to the Aretia orders contract for this network.');
  if (valueOf(tx) !== 0n) p.push('The proof carries coins, which it should not.');
  const d = typeof tx.data === 'string' ? decodeProve(tx.data) : null;
  if (!d) p.push('The transaction data is not a plain proof.');
  else {
    if (d.token !== c.token.toLowerCase()) p.push('The proof is for a different token than you chose.');
    if (d.factoryNonce !== c.factoryNonce) p.push('The proof names a different factory nonce than the one worked out for this token.');
  }
  return p;
}
