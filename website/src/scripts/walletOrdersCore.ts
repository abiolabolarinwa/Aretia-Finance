/**
 * Limit orders on the web wallet: the rules, with no page and no network, so each can be tested on its own.
 *
 * A limit order says "buy this token only at this price or better" or "sell it only at this price or better". The money moves into
 * an escrow that only the owner can cancel; anyone may then fill the order, and the order program refuses any fill that gives the
 * owner less than the price they set. The program, its client and its tests are in the Aretia Wallet repository
 * (programs/aretia-orders, docs/aretia-launch/adr/0007-order-program.md).
 *
 * This version trades Aretia Launch tokens against SOL (held as wrapped SOL while an order is open) on the web wallet's bonding
 * curve. Other payment assets and tokens that have left the curve come later.
 */
import { fromSmallestUnit, toSmallestUnit } from './walletTools';

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
const SOL_DECIMALS = 9;

/** 150n -> "1.5%", 200n -> "2%". Never integer division: a fee shown to a person must be the fee charged. */
export const percentText = (bps: bigint): string => `${Number(bps) / 100}%`;

export const feeCeil = (amount: bigint, bps: bigint): bigint => (amount * bps + BPS - 1n) / BPS;

// ---------------------------------------------------------------- the form

export type OrderSide = 'buy' | 'sell';

export interface OrderForm {
  /** The Launch token's address. */
  mint: string;
  side: OrderSide;
  /** Buy: SOL to spend. Sell: tokens to sell. */
  amount: string;
  /** SOL per whole token. The limit: the worst price the owner accepts, Aretia's fee included. */
  price: string;
}

export const DEFAULT_ORDER_FORM: OrderForm = {
  mint: '',
  side: 'buy',
  amount: '',
  price: '',
};

export interface OrderIssue {
  field: keyof OrderForm;
  message: string;
}

export interface OrderTerms {
  side: OrderSide;
  /** Escrowed now: lamports for a buy, token base units for a sell. */
  amountIn: bigint;
  /** The least the owner must end up holding: token base units for a buy, lamports for a sell. */
  minOut: bigint;
  /** The price as lamports per whole token. */
  priceLamports: bigint;
}

export interface OrderContext {
  decimals: number;
  /** Smallest order the program accepts for SOL, in lamports (read from the program's asset account). */
  minLamports: bigint;
  /** What the owner can escrow right now: SOL (wrapped or not) for a buy, tokens for a sell. */
  available: bigint;
}

const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** Turns what the person typed into exact amounts. Every rounding goes the way that protects the owner. */
export function orderTerms(form: OrderForm, decimals: number): OrderTerms | null {
  const price = toSmallestUnit(form.price.trim(), SOL_DECIMALS);
  const amount = toSmallestUnit(form.amount.trim(), form.side === 'buy' ? SOL_DECIMALS : decimals);
  if (price === null || amount === null) return null;
  const priceLamports = BigInt(price);
  const amountIn = BigInt(amount);
  if (priceLamports <= 0n || amountIn <= 0n) return null;
  const unit = 10n ** BigInt(decimals);
  // Buy: tokens = spend / price, rounded UP, so the order demands at least the price. Sell: SOL = tokens x price, rounded UP.
  const minOut = form.side === 'buy' ? ceilDiv(amountIn * unit, priceLamports) : ceilDiv(amountIn * priceLamports, unit);
  if (minOut <= 0n || amountIn > U64_MAX || minOut > U64_MAX) return null;
  return { side: form.side, amountIn, minOut, priceLamports };
}

export function validateOrder(form: OrderForm, isAddress: (s: string) => boolean, ctx: OrderContext | null): OrderIssue[] {
  const issues: OrderIssue[] = [];
  if (!isAddress(form.mint.trim())) issues.push({ field: 'mint', message: 'Paste the token’s address.' });
  if (!form.price.trim() || !/^\d+(\.\d+)?$/.test(form.price.trim()))
    issues.push({
      field: 'price',
      message: 'Enter the price in SOL per token, for example 0.00005.',
    });
  if (!form.amount.trim() || !/^\d+(\.\d+)?$/.test(form.amount.trim()))
    issues.push({
      field: 'amount',
      message: form.side === 'buy' ? 'Enter how much SOL to spend.' : 'Enter how many tokens to sell.',
    });
  if (issues.length || !ctx) return issues;

  const terms = orderTerms(form, ctx.decimals);
  if (!terms) {
    issues.push({
      field: 'amount',
      message: 'Those numbers do not make a valid order. Check the amount and price (at most 9 decimals for SOL).',
    });
    return issues;
  }
  // A buy is measured by what it spends, a sell by what it must bring in.
  const size = terms.side === 'buy' ? terms.amountIn : terms.minOut;
  if (size < ctx.minLamports)
    issues.push({
      field: 'amount',
      message: `The smallest order is ${fromSmallestUnit(ctx.minLamports, SOL_DECIMALS)} SOL.`,
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

export function previewOrder(terms: OrderTerms, decimals: number): OrderPreview {
  const sol = (l: bigint) => `${fromSmallestUnit(l, SOL_DECIMALS)} SOL`;
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
    // The sell fee is taken from the SOL that comes back; at the limit price that is about this much.
    fillFee: sol(feeCeil(terms.minOut, ORDER_SELL_FEE_BPS)),
    // The cancel fee on a sell is taken in the token that was escrowed.
    cancelFee: tok(feeCeil(terms.amountIn, ORDER_CANCEL_FEE_BPS)),
  };
}

export function orderDisclosures(side: OrderSide): { severity: 'info' | 'caution'; text: string }[] {
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
  const specific =
    side === 'buy'
      ? [
          {
            severity: 'info' as const,
            text: 'To place a buy, the SOL you spend is turned into wrapped SOL and held in escrow. If you cancel, you get wrapped SOL back and can turn it back into SOL here.',
          },
          {
            severity: 'info' as const,
            text: `If it fills, Aretia charges ${percentText(ORDER_BUY_FEE_BPS)} of what you spent. If you cancel, Aretia charges ${percentText(ORDER_CANCEL_FEE_BPS)} of what is unfilled.`,
          },
        ]
      : [
          {
            severity: 'info' as const,
            text: 'To place a sell, your tokens are held in escrow. You are paid in wrapped SOL, which you can turn back into SOL here.',
          },
          {
            severity: 'info' as const,
            text: `If it fills, Aretia charges ${percentText(ORDER_SELL_FEE_BPS)} of the SOL you receive. If you cancel, Aretia charges ${percentText(ORDER_CANCEL_FEE_BPS)} of the tokens still unfilled, taken in the token.`,
          },
        ];
  return [...specific, ...common];
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

/** Where the limit stands for a person: their price, from what is left to do. Null when nothing is left. */
export function limitPriceLamports(o: Pick<OrderAccount, 'inRemaining' | 'minOutRemaining' | 'side'>, decimals: number): bigint | null {
  if (o.inRemaining <= 0n || o.minOutRemaining <= 0n) return null;
  const unit = 10n ** BigInt(decimals);
  // Buy: lamports in per token out. Sell: lamports out per token in. Both are "lamports per whole token".
  return o.side === 'buy' ? (o.inRemaining * unit) / o.minOutRemaining : (o.minOutRemaining * unit) / o.inRemaining;
}
