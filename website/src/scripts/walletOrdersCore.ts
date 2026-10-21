/**
 * Limit orders on the web wallet: the rules, with no page and no network, so each can be tested on its own.
 *
 * A limit order says "buy this token only at this price or better" or "sell it only at this price or better". The money moves into
 * an escrow that only the owner can cancel; anyone may then fill the order, and the order program refuses any fill that gives the
 * owner less than the price they set. The program, its client and its tests are in the Aretia Wallet repository
 * (programs/aretia-orders, docs/aretia-launch/adr/0007-order-program.md).
 *
 * Aretia Launch tokens trade against SOL (held as wrapped SOL while an order is open) on the web wallet's bonding curve, and, once a
 * token has graduated to its Meteora pool, against SOL, USDC or USDT on that pool.
 */
import { fromSmallestUnit, toSmallestUnit } from './walletTools';
import { WRAPPED_SOL_MINT } from './walletOrdersTx';

// ---------------------------------------------------------------- where the program lives

/** The order program on each cluster, or null when it is not deployed there. Nothing is deployed yet, so the card does nothing. */
export const ORDERS_PROGRAM_ID_MAINNET: string | null = null;
export const ORDERS_PROGRAM_ID_DEVNET: string | null = null;

/** The build flag. Anything but the exact text "1" is off. */
export function ordersFlagOn(flag: string | undefined): boolean {
  return flag === '1';
}

export function ordersProgramFor(cluster: 'mainnet' | 'devnet'): string | null {
  return cluster === 'devnet' ? ORDERS_PROGRAM_ID_DEVNET : ORDERS_PROGRAM_ID_MAINNET;
}

// ---------------------------------------------------------------- the fees, as the owner set them

/** Charged only when an order fills (the order program copies these into the order when it is made). */
export const ORDER_BUY_FEE_BPS = 150n;
export const ORDER_SELL_FEE_BPS = 200n;
/** Charged on what is still unfilled when the owner cancels. */
export const ORDER_CANCEL_FEE_BPS = 58n;
/** Share of any price improvement that the filler (the "keeper") keeps. The owner still gets at least the price they set. */
export const KEEPER_SHARE_BPS = 2000n;
/** The bonding curve's own trading fee, paid inside every fill. It is already inside the price the owner sets. */
export const CURVE_FEE_BPS = 58n;

export const BPS = 10_000n;
const U64_MAX = (1n << 64n) - 1n;

// ---------------------------------------------------------------- the payment assets

export type QuoteSymbol = 'SOL' | 'USDC' | 'USDT';

/** A payment asset an order can be made in. All are classic-token mints; SOL is held as wrapped SOL while an order is open. */
export interface QuoteAsset {
  symbol: QuoteSymbol;
  mint: string;
  decimals: number;
  isSol: boolean;
}

export const QUOTE_SOL: QuoteAsset = { symbol: 'SOL', mint: WRAPPED_SOL_MINT, decimals: 9, isSol: true };
export const QUOTE_USDC: QuoteAsset = { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, isSol: false };
export const QUOTE_USDT: QuoteAsset = { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, isSol: false };

/** What a person can pay with. The stablecoin mints above are mainnet's, so devnet offers SOL only. */
export const quoteAssetsFor = (cluster: 'mainnet' | 'devnet'): QuoteAsset[] => (cluster === 'devnet' ? [QUOTE_SOL] : [QUOTE_SOL, QUOTE_USDC, QUOTE_USDT]);
export const quoteByMint = (mint: string): QuoteAsset | null => [QUOTE_SOL, QUOTE_USDC, QUOTE_USDT].find((q) => q.mint === mint) ?? null;
export const quoteBySymbol = (symbol: string): QuoteAsset | null => [QUOTE_SOL, QUOTE_USDC, QUOTE_USDT].find((q) => q.symbol === symbol) ?? null;

/** 150n -> "1.5%", 200n -> "2%". Never integer division: a fee shown to a person must be the fee charged. */
export const percentText = (bps: bigint): string => `${Number(bps) / 100}%`;

export const feeCeil = (amount: bigint, bps: bigint): bigint => (amount * bps + BPS - 1n) / BPS;

// ---------------------------------------------------------------- the form

export type OrderSide = 'buy' | 'sell';

export interface OrderForm {
  /** The Launch token's address. */
  mint: string;
  side: OrderSide;
  /** Buy: the payment asset to spend. Sell: tokens to sell. */
  amount: string;
  /** Payment asset per whole token. The limit: the worst price the owner accepts, Aretia's fee included. */
  price: string;
  /** What the order is paid in. */
  quote: QuoteSymbol;
}

export const DEFAULT_ORDER_FORM: OrderForm = {
  mint: '',
  side: 'buy',
  amount: '',
  price: '',
  quote: 'SOL',
};

export interface OrderIssue {
  field: keyof OrderForm;
  message: string;
}

export interface OrderTerms {
  side: OrderSide;
  /** Escrowed now: the payment asset's base units for a buy, token base units for a sell. */
  amountIn: bigint;
  /** The least the owner must end up holding: token base units for a buy, the payment asset's base units for a sell. */
  minOut: bigint;
  /** The price as the payment asset's base units per whole token. */
  priceQuote: bigint;
}

export interface OrderContext {
  decimals: number;
  /** Smallest order the program accepts for the payment asset, in its base units (read from the program's asset account). */
  minQuote: bigint;
  /** What the owner can escrow right now: the payment asset (for SOL, wrapped or not) for a buy, tokens for a sell. */
  available: bigint;
  /** The payment asset; SOL if absent. */
  quote?: QuoteAsset;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Turns what the person typed into exact amounts. Every rounding goes the way that protects the owner. */
export function orderTerms(form: OrderForm, decimals: number, quote: QuoteAsset = QUOTE_SOL): OrderTerms | null {
  const price = toSmallestUnit(form.price.trim(), quote.decimals);
  const amount = toSmallestUnit(form.amount.trim(), form.side === 'buy' ? quote.decimals : decimals);
  if (price === null || amount === null) return null;
  const priceQuote = BigInt(price);
  const amountIn = BigInt(amount);
  if (priceQuote <= 0n || amountIn <= 0n) return null;
  const unit = 10n ** BigInt(decimals);
  // Buy: tokens = spend / price, rounded UP, so the order demands at least the price. Sell: payment = tokens x price, rounded UP.
  const minOut = form.side === 'buy' ? ceilDiv(amountIn * unit, priceQuote) : ceilDiv(amountIn * priceQuote, unit);
  if (minOut <= 0n || amountIn > U64_MAX || minOut > U64_MAX) return null;
  return { side: form.side, amountIn, minOut, priceQuote };
}

export function validateOrder(form: OrderForm, isAddress: (s: string) => boolean, ctx: OrderContext | null): OrderIssue[] {
  const issues: OrderIssue[] = [];
  const quote = ctx?.quote ?? quoteBySymbol(form.quote) ?? QUOTE_SOL;
  if (!isAddress(form.mint.trim())) issues.push({ field: 'mint', message: 'Paste the token’s address.' });
  if (!form.price.trim() || !/^\d+(\.\d+)?$/.test(form.price.trim()))
    issues.push({
      field: 'price',
      message: quote.isSol ? 'Enter the price in SOL per token, for example 0.00005.' : `Enter the price in ${quote.symbol} per token, for example 0.05.`,
    });
  if (!form.amount.trim() || !/^\d+(\.\d+)?$/.test(form.amount.trim()))
    issues.push({
      field: 'amount',
      message: form.side === 'buy' ? `Enter how much ${quote.symbol} to spend.` : 'Enter how many tokens to sell.',
    });
  if (issues.length || !ctx) return issues;

  const terms = orderTerms(form, ctx.decimals, quote);
  if (!terms) {
    issues.push({
      field: 'amount',
      message: `Those numbers do not make a valid order. Check the amount and price (at most ${quote.decimals} decimals for ${quote.symbol}).`,
    });
    return issues;
  }
  // A buy is measured by what it spends, a sell by what it must bring in.
  const size = terms.side === 'buy' ? terms.amountIn : terms.minOut;
  if (size < ctx.minQuote)
    issues.push({
      field: 'amount',
      message: `The smallest order is ${fromSmallestUnit(ctx.minQuote, quote.decimals)} ${quote.symbol}.`,
    });
  if (terms.amountIn > ctx.available)
    issues.push({
      field: 'amount',
      message: 'You do not have enough for this order.',
    });
  return issues;
}

// ---------------------------------------------------------------- what the person is told

export interface OrderPreview {
  /** What leaves the wallet now and is held in escrow. */
  escrowed: string;
  /** What the order asks for at the very least. */
  atLeast: string;
  /** Aretia's fee if the whole order fills, estimated. */
  fillFee: string;
  /** Aretia's fee if the order is cancelled before anything fills. */
  cancelFee: string;
}

const grouped = (text: string): string => text.replace(/^(\d+)/, (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ','));

export function previewOrder(terms: OrderTerms, decimals: number, quote: QuoteAsset = QUOTE_SOL): OrderPreview {
  const sol = (l: bigint) => `${fromSmallestUnit(l, quote.decimals)} ${quote.symbol}`;
  const tok = (t: bigint) => `${grouped(fromSmallestUnit(t, decimals))} tokens`;
  if (terms.side === 'buy') {
    return {
      escrowed: sol(terms.amountIn),
      atLeast: tok(terms.minOut),
      fillFee: sol(feeCeil(terms.amountIn, ORDER_BUY_FEE_BPS)),
      cancelFee: sol(feeCeil(terms.amountIn, ORDER_CANCEL_FEE_BPS)),
    };
  }
  return {
    escrowed: tok(terms.amountIn),
    atLeast: sol(terms.minOut),
    // The sell fee is taken from the payment that comes back; at the limit price that is about this much.
    fillFee: sol(feeCeil(terms.minOut, ORDER_SELL_FEE_BPS)),
    // The cancel fee on a sell is taken in the token that was escrowed.
    cancelFee: tok(feeCeil(terms.amountIn, ORDER_CANCEL_FEE_BPS)),
  };
}

export function orderDisclosures(side: OrderSide, quote: QuoteAsset = QUOTE_SOL): { severity: 'info' | 'caution'; text: string }[] {
  const common: { severity: 'info' | 'caution'; text: string }[] = [
    {
      severity: 'caution',
      text: 'This is unaudited software. Orders are held by a program, not by Aretia, and only you can cancel yours. Do not use money you cannot afford to lose.',
    },
    {
      severity: 'info',
      text: 'Your order waits until the market reaches your price. Anyone can fill it; Aretia also runs a filler, but nothing guarantees an order fills. You can cancel at any time.',
    },
    {
      severity: 'info',
      text: 'The order is visible on the Solana blockchain to anyone who looks for it. This page shows only your own.',
    },
    {
      severity: 'info',
      text: 'Your price is the worst you will accept, with every fee included. If the market is better, you get the better price (the filler keeps part of the difference).',
    },
    {
      severity: 'info',
      text: 'An order is filled in pieces if the market only reaches your price for part of it. Each piece is at least 5% of the order.',
    },
  ];
  const q = quote.symbol;
  const venue = quote.isSol
    ? []
    : [
        {
          severity: 'info' as const,
          text: `${q} orders are filled on the token’s Meteora pool, which only exists once the token has graduated from its curve. If the pool is thin, your order may only fill in part, or not at all.`,
        },
      ];
  const specific =
    side === 'buy'
      ? [
          {
            severity: 'info' as const,
            text: quote.isSol
              ? 'To place a buy, the SOL you spend is turned into wrapped SOL and held in escrow. If you cancel, you get wrapped SOL back and can turn it back into SOL here.'
              : `To place a buy, the ${q} you spend is held in escrow. If you cancel, the unspent ${q} comes back to your wallet.`,
          },
          {
            severity: 'info' as const,
            text: `If it fills, Aretia charges ${percentText(ORDER_BUY_FEE_BPS)} of the ${q} you spent. If you cancel, Aretia charges ${percentText(ORDER_CANCEL_FEE_BPS)} of what is unfilled.`,
          },
        ]
      : [
          {
            severity: 'info' as const,
            text: quote.isSol
              ? 'To place a sell, your tokens are held in escrow. You are paid in wrapped SOL, which you can turn back into SOL here.'
              : `To place a sell, your tokens are held in escrow. You are paid in ${q}.`,
          },
          {
            severity: 'info' as const,
            text: `If it fills, Aretia charges ${percentText(ORDER_SELL_FEE_BPS)} of the ${q} you receive. If you cancel, Aretia charges ${percentText(ORDER_CANCEL_FEE_BPS)} of the tokens still unfilled, taken in the token.`,
          },
        ];
  return [...venue, ...specific, ...common];
}

// ---------------------------------------------------------------- reading the program's accounts

/** First eight bytes of an Order account: sha256("account:Order"). */
export const ORDER_ACCOUNT_DISCRIMINATOR = Uint8Array.from([134, 173, 223, 185, 77, 86, 28, 51]);
export const ORDER_ACCOUNT_SIZE = 235;
export const ASSET_ACCOUNT_DISCRIMINATOR_SIZE = 8;

export interface OrderAccount {
  owner: string;
  launchMint: string;
  quoteMint: string;
  launchTokenProgram: string;
  quoteTokenProgram: string;
  side: OrderSide;
  nonce: bigint;
  inTotal: bigint;
  inRemaining: bigint;
  minOutRemaining: bigint;
  feeBaseCum: bigint;
  feePaid: bigint;
  cancelFeeBps: number;
  status: number;
}

/** Reads an Order account. Null unless it is exactly the right size, starts with the right discriminator and has a real side. */
export function parseOrderAccount(keyToString: (bytes: Uint8Array) => string, data: Uint8Array): OrderAccount | null {
  if (data.length !== ORDER_ACCOUNT_SIZE) return null;
  if (!ORDER_ACCOUNT_DISCRIMINATOR.every((b, i) => data[i] === b)) return null;
  const body = data.subarray(8);
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const key = (o: number) => keyToString(body.subarray(o, o + 32));
  const side = body[160];
  if (side !== 0 && side !== 1) return null;
  return {
    owner: key(0),
    launchMint: key(32),
    quoteMint: key(64),
    launchTokenProgram: key(96),
    quoteTokenProgram: key(128),
    side: side === 0 ? 'buy' : 'sell',
    nonce: v.getBigUint64(161, true),
    inTotal: v.getBigUint64(169, true),
    inRemaining: v.getBigUint64(177, true),
    minOutRemaining: v.getBigUint64(185, true),
    feeBaseCum: v.getBigUint64(193, true),
    feePaid: v.getBigUint64(201, true),
    cancelFeeBps: v.getUint16(209, true),
    status: body[217]!,
  };
}

export interface AssetAccount {
  mint: string;
  minAmount: bigint;
  enabled: boolean;
}

/** An Asset account: discriminator, mint, smallest order, enabled flag, bump. */
export function parseAssetAccount(keyToString: (bytes: Uint8Array) => string, data: Uint8Array): AssetAccount | null {
  if (data.length !== 8 + 32 + 8 + 1 + 1) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: keyToString(data.subarray(8, 40)),
    minAmount: v.getBigUint64(40, true),
    enabled: data[48] === 1,
  };
}

/** Where the limit stands for a person: their price, from what is left to do, in the payment asset's base units per whole token. Null when nothing is left. */
export function limitPrice(o: Pick<OrderAccount, 'inRemaining' | 'minOutRemaining' | 'side'>, decimals: number): bigint | null {
  if (o.inRemaining <= 0n || o.minOutRemaining <= 0n) return null;
  const unit = 10n ** BigInt(decimals);
  // Buy: payment in per token out. Sell: payment out per token in. Both are "payment per whole token".
  return o.side === 'buy' ? (o.inRemaining * unit) / o.minOutRemaining : (o.minOutRemaining * unit) / o.inRemaining;
}
