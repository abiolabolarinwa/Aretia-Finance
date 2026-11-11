/**
 * Limit orders on Ethereum-style chains: the rules, with no page and no network, so each can be tested on its own.
 *
 * Same idea as the Solana card (walletOrdersCore.ts): the money moves into an escrow that only the owner can cancel, anyone may fill the
 * order, and the contract reverts any fill that gives the owner less than the price they set. The contract (AretiaOrders.sol), its client
 * and its tests are in the Aretia Wallet repository (packages/launch-evm, docs/aretia-launch/adr/0007-order-program.md).
 *
 * One thing differs and the page says so: the contract keeps every order's escrow in ONE pool of tokens. Its accounting is checked, but an
 * error in it could affect every order at once. The card stays off unless the build sets PUBLIC_ORDERS_EVM_ENABLED=1, and shows a notice
 * and no form for any network without a deployed contract in EVM_ORDERS_ADDRESSES.
 */
import { fromSmallestUnit, toSmallestUnit } from './walletTools';
import { type LaunchEvmChainKey, chainByKey, isEvmAddress } from './walletLaunchEvmCore';
import { dexFor } from './walletPoolEvmCore';
import { ORDER_BUY_FEE_BPS, ORDER_CANCEL_FEE_BPS, ORDER_SELL_FEE_BPS, feeCeil, percentText, type OrderSide, type OrderTerms } from './walletOrdersCore';

/** The build flag. Anything but the exact text "1" is off. */
export const evmOrdersFlagOn = (flag: string | undefined): boolean => flag === '1';

export interface EvmOrdersAddresses {
  /** The AretiaOrders contract, lower-case. */
  orders: string;
  /** The block it was deployed in, so a person's orders can be found without scanning the whole chain. */
  fromBlock: number;
}

/** The deployed AretiaOrders on each chain. NULL UNTIL DEPLOYED: nothing is deployed, so the card does nothing anywhere. */
export const EVM_ORDERS_ADDRESSES: Readonly<Partial<Record<LaunchEvmChainKey, EvmOrdersAddresses | null>>> = {
  ethereum: null,
  bnb: null,
  polygon: null,
};

/** A payment asset. `native` means the chain's own coin, which the contract wraps for a buy; the order is then against the wrapped token. */
export interface EvmQuote {
  symbol: string;
  /** The token the order is made against, lower-case. For the native coin this is the wrapped token. */
  address: string;
  decimals: number;
  native: boolean;
}

export interface EvmOrdersChain {
  key: LaunchEvmChainKey;
  chainId: number;
  name: string;
  /** The native coin's symbol. */
  symbol: string;
  explorer: string;
  orders: string;
  fromBlock: number;
  /** The token factory; the orders contract is deployed with it and checks that a token came from it. */
  factory: string;
  /** The exchange fills go through (the router the contract has whitelisted) and the pair factory used to check a pool exists. */
  router: string;
  pairFactory: string;
  wrapped: string;
  quotes: EvmQuote[];
}

/** The chain's order setup, or null when there is no deployed contract or the chain lacks the exchange details. */
export function evmOrdersChain(key: string, addresses: Readonly<Partial<Record<LaunchEvmChainKey, EvmOrdersAddresses | null>>> = EVM_ORDERS_ADDRESSES): EvmOrdersChain | null {
  const k = key as LaunchEvmChainKey;
  const chain = chainByKey(k);
  const a = addresses[k];
  const dex = dexFor(k);
  if (!chain || !chain.factory || !dex || !a || !isEvmAddress(a.orders) || a.orders !== a.orders.toLowerCase()) return null;
  return {
    key: k,
    chainId: chain.chainId,
    name: chain.name,
    symbol: chain.symbol,
    explorer: chain.explorer,
    orders: a.orders,
    fromBlock: a.fromBlock,
    factory: chain.factory,
    router: dex.router,
    pairFactory: dex.factory,
    wrapped: dex.wrapped,
    quotes: [
      { symbol: chain.symbol, address: dex.wrapped, decimals: 18, native: true },
      { symbol: 'USDC', address: dex.stables.USDC.address, decimals: dex.stables.USDC.decimals, native: false },
      { symbol: 'USDT', address: dex.stables.USDT.address, decimals: dex.stables.USDT.decimals, native: false },
    ],
  };
}

// ---------------------------------------------------------------- the form

export interface EvmOrderForm {
  token: string;
  side: OrderSide;
  /** The payment asset's symbol. */
  quote: string;
  /** Buy: the payment asset to spend. Sell: tokens to sell. */
  amount: string;
  /** Payment asset per whole token: the worst price the owner accepts, Aretia's fee included. */
  price: string;
}
export const DEFAULT_EVM_ORDER_FORM: EvmOrderForm = { token: '', side: 'buy', quote: '', amount: '', price: '' };

export interface EvmOrderIssue {
  field: keyof EvmOrderForm;
  message: string;
}

const MAX_UINT = (1n << 256n) - 1n;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Turns what the person typed into exact amounts. Every rounding goes the way that protects the owner. */
export function evmOrderTerms(form: EvmOrderForm, tokenDecimals: number, quote: EvmQuote): OrderTerms | null {
  const price = toSmallestUnit(form.price.trim(), quote.decimals);
  const amount = toSmallestUnit(form.amount.trim(), form.side === 'buy' ? quote.decimals : tokenDecimals);
  if (price === null || amount === null) return null;
  const priceQuote = BigInt(price);
  const amountIn = BigInt(amount);
  if (priceQuote <= 0n || amountIn <= 0n) return null;
  const unit = 10n ** BigInt(tokenDecimals);
  const minOut = form.side === 'buy' ? ceilDiv(amountIn * unit, priceQuote) : ceilDiv(amountIn * priceQuote, unit);
  if (minOut <= 0n || amountIn > MAX_UINT || minOut > MAX_UINT) return null;
  return { side: form.side, amountIn, minOut, priceQuote };
}

export interface EvmOrderContext {
  tokenDecimals: number;
  quote: EvmQuote;
  /** The contract's smallest order for this payment asset, in its base units (0 means the asset is not switched on). */
  minQuote: bigint;
  /** What the owner can escrow now: the payment asset (the native coin, less gas, for a native buy) for a buy, tokens for a sell. */
  available: bigint;
}

export function validateEvmOrder(form: EvmOrderForm, ctx: EvmOrderContext | null): EvmOrderIssue[] {
  const issues: EvmOrderIssue[] = [];
  const q = ctx?.quote;
  if (!isEvmAddress(form.token.trim())) issues.push({ field: 'token', message: 'Paste the token’s address (it starts with 0x).' });
  if (!/^\d+(\.\d+)?$/.test(form.price.trim())) issues.push({ field: 'price', message: `Enter the price in ${q?.symbol ?? 'the payment asset'} per token, for example 0.05.` });
  if (!/^\d+(\.\d+)?$/.test(form.amount.trim()))
    issues.push({ field: 'amount', message: form.side === 'buy' ? `Enter how much ${q?.symbol ?? 'of the payment asset'} to spend.` : 'Enter how many tokens to sell.' });
  if (issues.length || !ctx || !q) return issues;
  const terms = evmOrderTerms(form, ctx.tokenDecimals, q);
  if (!terms) return [{ field: 'amount', message: `Those numbers do not make a valid order. Check the amount and price (at most ${q.decimals} decimals for ${q.symbol}).` }];
  const size = terms.side === 'buy' ? terms.amountIn : terms.minOut;
  if (ctx.minQuote === 0n) issues.push({ field: 'amount', message: `Orders in ${q.symbol} are not switched on.` });
  else if (size < ctx.minQuote) issues.push({ field: 'amount', message: `The smallest order is ${fromSmallestUnit(ctx.minQuote, q.decimals)} ${q.symbol}.` });
  if (terms.amountIn > ctx.available) issues.push({ field: 'amount', message: 'You do not have enough for this order.' });
  return issues;
}

// ---------------------------------------------------------------- what the person is told

const grouped = (text: string): string => text.replace(/^(\d+)/, (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','));

export interface EvmOrderPreview {
  escrowed: string;
  atLeast: string;
  fillFee: string;
  cancelFee: string;
}
export function previewEvmOrder(terms: OrderTerms, tokenDecimals: number, quote: EvmQuote): EvmOrderPreview {
  const pay = (v: bigint) => `${fromSmallestUnit(v, quote.decimals)} ${quote.symbol}`;
  const tok = (v: bigint) => `${grouped(fromSmallestUnit(v, tokenDecimals))} tokens`;
  if (terms.side === 'buy')
    return { escrowed: pay(terms.amountIn), atLeast: tok(terms.minOut), fillFee: pay(feeCeil(terms.amountIn, ORDER_BUY_FEE_BPS)), cancelFee: pay(feeCeil(terms.amountIn, ORDER_CANCEL_FEE_BPS)) };
  return { escrowed: tok(terms.amountIn), atLeast: pay(terms.minOut), fillFee: pay(feeCeil(terms.minOut, ORDER_SELL_FEE_BPS)), cancelFee: tok(feeCeil(terms.amountIn, ORDER_CANCEL_FEE_BPS)) };
}

export function evmOrderDisclosures(side: OrderSide, quote: EvmQuote, chain: Pick<EvmOrdersChain, 'name' | 'symbol'>): { severity: 'info' | 'caution'; text: string }[] {
  const q = quote.symbol;
  const out: { severity: 'info' | 'caution'; text: string }[] = [
    { severity: 'caution', text: 'This is unaudited software. Orders are held by a contract, not by Aretia, and only you can cancel yours. Do not use money you cannot afford to lose.' },
    { severity: 'caution', text: 'The contract keeps everyone’s escrow in one pool of tokens. Its accounting is tested, but a flaw in it could affect every open order at once, not only yours.' },
    {
      severity: 'info',
      text: `Your order waits until the market reaches your price. Anyone can fill it; Aretia also runs a filler, but nothing guarantees an order fills. You can cancel at any time.`,
    },
    { severity: 'info', text: `The order is visible on the ${chain.name} blockchain to anyone who looks for it. This page shows only your own.` },
    { severity: 'info', text: 'Your price is the worst you will accept, with every fee included. If the market is better, you get the better price (the filler keeps part of the difference).' },
    { severity: 'info', text: 'An order is filled in pieces if the market only reaches your price for part of it. Each piece is at least 5% of the order.' },
    { severity: 'info', text: `Fills go through the token’s ${chain.name} exchange pool. If it is thin, your order may only fill in part, or not at all.` },
  ];
  if (side === 'buy')
    out.unshift({
      severity: 'info',
      text: quote.native
        ? `To place a buy, the ${chain.symbol} you spend is wrapped and held in escrow as wrapped ${chain.symbol}. If you cancel, you get wrapped ${chain.symbol} back, which you can keep or unwrap in your wallet.`
        : `To place a buy, the ${q} you spend is held in escrow. If you cancel, the unspent ${q} comes back to your wallet.`,
    });
  else if (quote.native) out.unshift({ severity: 'info', text: `A sell is paid in wrapped ${chain.symbol}, not the plain coin. Unwrap it in your wallet if you want the coin.` });
  out.unshift(
    side === 'buy'
      ? {
          severity: 'info',
          text: `If it fills, Aretia charges ${percentText(ORDER_BUY_FEE_BPS)} of the ${q} you spent. If you cancel, Aretia charges ${percentText(ORDER_CANCEL_FEE_BPS)} of what is unfilled.`,
        }
      : {
          severity: 'info',
          text: `If it fills, Aretia charges ${percentText(ORDER_SELL_FEE_BPS)} of the ${q} you receive. If you cancel, Aretia charges ${percentText(ORDER_CANCEL_FEE_BPS)} of the tokens still unfilled, taken in the token.`,
        },
  );
  if (side === 'sell') out.push({ severity: 'info', text: 'Tokens that charge a fee on every transfer cannot be used in orders; the contract refuses them.' });
  return out;
}

// ---------------------------------------------------------------- reading an order back

export interface EvmOrderRecord {
  id: bigint;
  owner: string;
  launchToken: string;
  quoteToken: string;
  isBuy: boolean;
  cancelBps: number;
  inTotal: bigint;
  inRemaining: bigint;
  minOutRemaining: bigint;
}

/** The result of `orders(id)`: thirteen words. Null unless it is exactly that and names an owner. */
export function parseEvmOrder(id: bigint, ret: unknown): EvmOrderRecord | null {
  if (typeof ret !== 'string' || !/^0x[0-9a-fA-F]{832}$/.test(ret)) return null;
  const w = (i: number) => ret.slice(2 + i * 64, 2 + (i + 1) * 64).toLowerCase();
  const addr = (i: number) => (/^0{24}[0-9a-f]{40}$/.test(w(i)) ? '0x' + w(i).slice(24) : null);
  const owner = addr(0);
  const launchToken = addr(1);
  const quoteToken = addr(2);
  if (!owner || /^0x0{40}$/.test(owner) || !launchToken || !quoteToken) return null;
  const flag = BigInt('0x' + w(3));
  if (flag > 1n) return null;
  return {
    id,
    owner,
    launchToken,
    quoteToken,
    isBuy: flag === 1n,
    cancelBps: Number(BigInt('0x' + w(4))),
    inTotal: BigInt('0x' + w(8)),
    inRemaining: BigInt('0x' + w(9)),
    minOutRemaining: BigInt('0x' + w(10)),
  };
}

/** The price an order is waiting for, in the payment asset's base units per whole token. Null when nothing is left. */
export function evmLimitPrice(o: Pick<EvmOrderRecord, 'inRemaining' | 'minOutRemaining' | 'isBuy'>, tokenDecimals: number): bigint | null {
  if (o.inRemaining <= 0n || o.minOutRemaining <= 0n) return null;
  const unit = 10n ** BigInt(tokenDecimals);
  return o.isBuy ? (o.inRemaining * unit) / o.minOutRemaining : (o.minOutRemaining * unit) / o.inRemaining;
}
