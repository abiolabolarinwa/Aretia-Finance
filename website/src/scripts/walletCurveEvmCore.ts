/**
 * Aretia Launch on Ethereum-style chains: the rules for selling a token on Aretia's own bonding curve, with no network access and no keys.
 *
 * The contract is contracts-evm/AretiaCurve.sol (design record: docs/BONDING_CURVE_EVM.md). It is UNAUDITED, and it IS deployed and
 * immutable on Ethereum, BNB Chain and Polygon (addresses below). This file is its web side. The maths is the Solana curve's, in BigInt,
 * written to match contracts-evm exactly and checked against it by walletCurveEvmContract.test.ts; it has no 64-bit limit because wei
 * amounts need more.
 *
 * The card stays off unless the build sets PUBLIC_CURVE_ENABLED=1. Known issues of the deployed contract are handled around it here: the
 * share of supply outside a curve is shown on every card (review finding M-3), and a graduation blocked by a pre-made pair can go through
 * the rescue helper once it is deployed (M-4, L-12; EVM_CURVE_RESCUE_ADDRESSES).
 */
import { fromSmallestUnit, toSmallestUnit } from './walletTools';
import { CURVE_FEE_BPS } from './walletCurveCore';
import { chainByKey, isEvmAddress, type LaunchEvmChainKey } from './walletLaunchEvmCore';
import { POOL_DEXES, type PoolDex } from './walletPoolEvmCore';
import { keccak256 } from '../swings/core/keccak.js';

/** The deployed AretiaCurve on each chain, lower-case. Nothing works for a chain whose entry is null. */
export const EVM_CURVE_ADDRESSES: Readonly<Partial<Record<LaunchEvmChainKey, string | null>>> = {
  // Ethereum mainnet, deployed from a fresh gas-only wallet and checked byte for byte by scripts/curve-mainnet.mjs verify. The card stays off unless the build sets PUBLIC_CURVE_ENABLED=1.
  ethereum: '0x4e85bc5bd6f08fa87ceb749372e34226556837e8',
  // BNB Chain mainnet, same deployer and nonce as Ethereum so the same address; checked by scripts/curve-mainnet.mjs verify.
  bnb: '0x4e85bc5bd6f08fa87ceb749372e34226556837e8',
  // Polygon mainnet, same deployer and nonce as Ethereum so the same address; checked by scripts/curve-mainnet.mjs verify.
  polygon: '0x4e85bc5bd6f08fa87ceb749372e34226556837e8',
};

/**
 * The deployed AretiaCurveRescue (contracts-evm/AretiaCurveRescue.sol) for each chain's curve, lower-case. NULL UNTIL DEPLOYED: the owner
 * deploys it per chain (docs/BONDING_CURVE_EVM.md, "Deploying the rescue helper and the pair seeder"), checks it, then writes it here.
 * While null, a graduation blocked by a pre-made pair is explained and only the 7-day unwind is offered.
 */
export const EVM_CURVE_RESCUE_ADDRESSES: Readonly<Partial<Record<LaunchEvmChainKey, string | null>>> = {
  ethereum: null,
  bnb: null,
  polygon: null,
};

export const EVM_MIN_TARGET_WEI = 10n ** 16n;
export const EVM_MAX_TARGET_WEI = 10n ** 24n;
export const EVM_MAX_TOTAL = 1n << 96n;
export const EVM_ABORT_AFTER_SECS = 7 * 24 * 60 * 60;
export const EVM_FEE_BPS = CURVE_FEE_BPS;
/** One-tap raise targets, in whole coins of the chain. */
export const EVM_TARGET_PRESETS = ['1', '5', '20'] as const;
export const EVM_SLIPPAGE_BPS_DEFAULT = 100;
/** The most CREATE nonces looked through to prove a token came from the factory. */
export const MAX_NONCE_SEARCH = 300_000n;

const BPS = 10_000n;

export interface EvmCurveChain {
  key: LaunchEvmChainKey;
  chainId: number;
  name: string;
  symbol: string;
  explorer: string;
  /** The AretiaCurve contract, lower-case. */
  curve: string;
  /** The token factory the curve accepts tokens from, lower-case. */
  factory: string;
  dex: PoolDex;
  /** The rescue-graduate helper for this curve, lower-case, or null when none is deployed (then no "Graduate anyway"). */
  rescue: string | null;
}

/** The chain's curve setup, or null when there is no deployed contract, or the chain lacks a factory or an exchange. */
export function evmCurveChain(
  key: string,
  addresses: Readonly<Partial<Record<LaunchEvmChainKey, string | null>>> = EVM_CURVE_ADDRESSES,
  rescues: Readonly<Partial<Record<LaunchEvmChainKey, string | null>>> = EVM_CURVE_RESCUE_ADDRESSES,
): EvmCurveChain | null {
  const k = key as LaunchEvmChainKey;
  const chain = chainByKey(k);
  const curve = addresses[k];
  const dex = POOL_DEXES.find((d) => d.key === k);
  if (!chain || !curve || !chain.factory || !dex || !isEvmAddress(curve)) return null;
  const r = rescues[k];
  const rescue = r && isEvmAddress(r) ? r.toLowerCase() : null;
  return { key: k, chainId: chain.chainId, name: chain.name, symbol: chain.symbol, explorer: chain.explorer, curve: curve.toLowerCase(), factory: chain.factory, dex, rescue };
}

// ---------------------------------------------------------------- the maths (the contract's, in BigInt)

export interface EvmMath {
  vSol: bigint;
  vTok: bigint;
  realSol: bigint;
  realTok: bigint;
}

export interface EvmDerived {
  vSol0: bigint;
  vTok0: bigint;
  curveTokens: bigint;
  lpTokens: bigint;
}

const ceilDiv = (a: bigint, b: bigint): bigint => a / b + (a % b === 0n ? 0n : 1n);
export const evmFeeUp = (amount: bigint): bigint => ceilDiv(amount * BigInt(EVM_FEE_BPS), BPS);

export function evmDerive(total: bigint, target: bigint): EvmDerived | null {
  if (total <= 0n || total > EVM_MAX_TOTAL || target < EVM_MIN_TARGET_WEI || target > EVM_MAX_TARGET_WEI) return null;
  const vSol0 = (target * 6n) / 17n;
  const lp = (total * vSol0) / (2n * vSol0 + target);
  const c = total - lp;
  if (lp === 0n || c === 0n) return null;
  const vTok0 = ceilDiv((vSol0 + target) * c, target);
  if (vTok0 <= c) return null;
  return { vSol0, vTok0, curveTokens: c, lpTokens: lp };
}

export const evmStart = (d: EvmDerived): EvmMath => ({ vSol: d.vSol0, vTok: d.vTok0, realSol: 0n, realTok: d.curveTokens });

export interface EvmBuyQuote {
  gross: bigint;
  fee: bigint;
  net: bigint;
  tokensOut: bigint;
  soldOut: boolean;
  next: EvmMath;
}

/** What the contract's `buy` does for a payment of `offered`: fee up and first, tokens down, an oversized payment cut to what is left and priced up. */
export function evmQuoteBuy(m: EvmMath, offered: bigint): EvmBuyQuote | null {
  if (offered <= 0n) return null;
  let fee = evmFeeUp(offered);
  if (fee > offered) fee = offered;
  let net = offered - fee;
  if (net === 0n || m.realTok === 0n) return null;
  const k = m.vSol * m.vTok;
  let out = m.vTok - ceilDiv(k, m.vSol + net);
  let gross = offered;
  if (out >= m.realTok) {
    const targetVTok = m.vTok - m.realTok;
    if (targetVTok === 0n) return null;
    net = ceilDiv(k, targetVTok) - m.vSol;
    gross = ceilDiv(net * BPS, BPS - BigInt(EVM_FEE_BPS));
    fee = gross - net;
    out = m.realTok;
  }
  if (out === 0n || gross > offered) return null;
  const next: EvmMath = { vSol: m.vSol + net, vTok: m.vTok - out, realSol: m.realSol + net, realTok: m.realTok - out };
  return { gross, fee, net, tokensOut: out, soldOut: next.realTok === 0n, next };
}

export interface EvmSellQuote {
  gross: bigint;
  fee: bigint;
  net: bigint;
  next: EvmMath;
}

/** What the contract's `sell` does for `tokens` handed back. */
export function evmQuoteSell(m: EvmMath, curveTokens: bigint, tokens: bigint): EvmSellQuote | null {
  if (tokens <= 0n || m.realTok + tokens > curveTokens) return null;
  const newVTok = m.vTok + tokens;
  const newVSol = ceilDiv(m.vSol * m.vTok, newVTok);
  if (newVSol > m.vSol) return null;
  const gross = m.vSol - newVSol;
  if (gross > m.realSol) return null;
  let fee = evmFeeUp(gross);
  if (fee > gross) fee = gross;
  return { gross, fee, net: gross - fee, next: { vSol: newVSol, vTok: newVTok, realSol: m.realSol - gross, realTok: m.realTok + tokens } };
}

export const evmMinOut = (quoted: bigint, slippageBps: number): bigint => (quoted * (BPS - BigInt(slippageBps))) / BPS;

/** Coin per whole token at a marginal price, in the coin's smallest unit, as text with up to 18 places. */
export function evmPriceText(m: Pick<EvmMath, 'vSol' | 'vTok'>, decimals: number): string {
  return fromSmallestUnit((m.vSol * 10n ** BigInt(decimals)) / m.vTok, 18);
}

// ---------------------------------------------------------------- proving a token came from the factory

const hexBytes = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));

/** The address a CREATE from `deployer` at contract nonce `n` makes: keccak256(rlp([deployer, n])), last 20 bytes. Lower-case. */
export function createAddress(deployer: string, n: bigint): string {
  const a = deployer.slice(2).toLowerCase();
  let nonce: string;
  if (n === 0n) nonce = '80';
  else if (n <= 0x7fn) nonce = n.toString(16).padStart(2, '0');
  else {
    const hex = n.toString(16);
    const body = hex.length % 2 === 0 ? hex : '0' + hex;
    nonce = (0x80 + body.length / 2).toString(16) + body;
  }
  const payloadLen = 1 + 20 + nonce.length / 2;
  const encoded = (0xc0 + payloadLen).toString(16) + '94' + a + nonce;
  const hash = keccak256(hexBytes(encoded));
  return '0x' + [...hash.slice(12)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * The factory's CREATE nonce that made `token`, or null if the factory did not make it. `nextNonce` is the factory account's nonce now (the
 * nonce its next token would use); the search goes from the newest token down, since a creator opens a curve soon after making the token.
 */
export function findFactoryNonce(factory: string, token: string, nextNonce: bigint, limit: bigint = MAX_NONCE_SEARCH): bigint | null {
  const want = token.toLowerCase();
  let n = nextNonce - 1n;
  for (let tried = 0n; n >= 1n && tried < limit; n--, tried++) if (createAddress(factory, n) === want) return n;
  return null;
}

// ---------------------------------------------------------------- reading a curve from the chain

export type EvmCurveStatus = 'none' | 'trading' | 'soldOut' | 'migrated' | 'aborted';
const STATUSES: EvmCurveStatus[] = ['none', 'trading', 'soldOut', 'migrated', 'aborted'];

export interface EvmCurveState extends EvmMath {
  status: EvmCurveStatus;
  creator: string;
  createdAt: bigint;
  soldOutAt: bigint;
  feeBps: bigint;
  target: bigint;
  vSol0: bigint;
  curveTokens: bigint;
  lpTokens: bigint;
}

/** Decodes the answer of `curves(address)`: thirteen 32-byte words. Null for anything else. */
export function parseCurveReturn(hex: unknown): EvmCurveState | null {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{832}$/.test(hex)) return null;
  const w = (i: number): bigint => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
  const status = STATUSES[Number(w(0))];
  if (!status || w(0) > 4n || w(1) >> 160n !== 0n) return null;
  return {
    status,
    creator: '0x' + hex.slice(2 + 64 + 24, 2 + 128).toLowerCase(),
    createdAt: w(2),
    soldOutAt: w(3),
    feeBps: w(4),
    target: w(5),
    vSol0: w(6),
    curveTokens: w(7),
    lpTokens: w(8),
    vSol: w(9),
    vTok: w(10),
    realSol: w(11),
    realTok: w(12),
  };
}

/** The reserve rules every curve must satisfy. A curve read back that breaks one is not shown as healthy. */
export function evmCurveProblems(c: EvmCurveState): string[] {
  const out: string[] = [];
  if (c.vSol - c.realSol !== c.vSol0) out.push('The curve’s reserves do not add up.');
  if (c.realTok > c.curveTokens) out.push('The curve claims more tokens for sale than it was given.');
  if (c.feeBps !== BigInt(EVM_FEE_BPS)) out.push(`This curve charges ${Number(c.feeBps) / 100}%, not the ${EVM_FEE_BPS / 100}% this page shows.`);
  return out;
}

export const evmCanGraduate = (c: EvmCurveState): boolean => c.status === 'soldOut' && c.realTok === 0n;

// ---------------------------------------------------------------- supply outside the curve (review finding M-3)

export interface EvmSupplyOutside {
  totalSupply: bigint;
  /** Tokens the curve was given: for sale plus kept for the pool. */
  committed: bigint;
  /** Supply never put into the curve. Holders of it can sell into the curve up to what buyers have bought, ahead of them. */
  outside: bigint;
  /** Shares of the total supply, in basis points (rounded: outside up, committed down, so the warning is never understated). */
  committedBps: number;
  outsideBps: number;
}

/** How much of a token's supply is on its curve and how much is outside it. */
export function evmSupplyOutside(totalSupply: bigint, c: Pick<EvmCurveState, 'curveTokens' | 'lpTokens'>): EvmSupplyOutside {
  const committed = c.curveTokens + c.lpTokens;
  const outside = totalSupply > committed ? totalSupply - committed : 0n;
  if (totalSupply === 0n) return { totalSupply, committed, outside, committedBps: 0, outsideBps: 0 };
  const outsideBps = Number(ceilDiv(outside * BPS, totalSupply));
  return { totalSupply, committed, outside, committedBps: 10_000 - outsideBps, outsideBps };
}

const pctText = (bps: number): string => (bps / 100).toFixed(2).replace(/\.?0+$/, '');

/**
 * The warning shown on every curve card and before opening a curve with less than the whole supply. Null when the whole supply is on the
 * curve. `openerHeld` is the curve opener's live balance, when known.
 */
export function evmOutsideWarning(o: EvmSupplyOutside, openerHeld: bigint | null, fmt: (raw: bigint) => string): string | null {
  if (o.outside === 0n) return null;
  const opener = openerHeld === null ? '' : ` The wallet that opened this curve holds ${fmt(openerHeld)} of them right now.`;
  return `${pctText(o.outsideBps)}% of supply (${fmt(o.outside)} tokens) is outside this curve; holders of it can sell ahead of you. The curve pays sellers from what buyers paid in, so if they sell first, buyers can be left unable to sell back.${opener}`;
}
export const evmCanAbort = (c: EvmCurveState, nowSecs: number): boolean => c.status === 'soldOut' && BigInt(nowSecs) >= c.soldOutAt + BigInt(EVM_ABORT_AFTER_SECS);

// ---------------------------------------------------------------- creating a curve

export interface EvmCurveForm {
  chain: LaunchEvmChainKey;
  token: string;
  /** Whole tokens, commas allowed. */
  tokenAmount: string;
  /** Coin to raise, plain decimal. */
  target: string;
  /** Optional coin for the creator's own first buy, made in the same transaction. */
  firstBuy: string;
}

export const DEFAULT_EVM_CURVE_FORM: EvmCurveForm = { chain: 'ethereum', token: '', tokenAmount: '', target: '5', firstBuy: '' };

/** What is known about the token before a curve is opened. */
export interface EvmCurveToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  supply: bigint;
  /** The creator's balance, smallest unit. */
  held: bigint;
  /** The factory nonce that made it, or null if the factory did not (then no curve can be opened). */
  factoryNonce: bigint | null;
}

export interface EvmCurveConfig {
  chain: EvmCurveChain;
  creator: string;
  token: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenSupply: bigint;
  factoryNonce: bigint;
  totalRaw: bigint;
  targetWei: bigint;
  firstBuyWei: bigint;
  derived: EvmDerived;
}

export interface EvmCurveIssue {
  field: keyof EvmCurveForm | 'form';
  message: string;
}

export type EvmCurveValidation = { ok: true; config: EvmCurveConfig } | { ok: false; issues: EvmCurveIssue[] };

/** "5" or "0.25" -> wei. Null unless a plain positive decimal with at most 18 places. */
export function coinToWei(text: string): bigint | null {
  const raw = toSmallestUnit(text.replace(/,/g, '').trim(), 18);
  if (raw === null) return null;
  const v = BigInt(raw);
  return v > 0n ? v : null;
}

export function validateEvmCurve(form: EvmCurveForm, creator: string, token: EvmCurveToken | null): EvmCurveValidation {
  const issues: EvmCurveIssue[] = [];
  const add = (field: EvmCurveIssue['field'], message: string) => issues.push({ field, message });
  const chain = evmCurveChain(form.chain);
  if (!chain) add('form', 'The bonding curve is not available on this network yet.');
  if (!isEvmAddress(creator)) add('form', 'Connect a wallet first.');
  if (!isEvmAddress(form.token.trim())) add('token', 'A valid token address, starting with 0x.');
  else if (token === null) add('token', 'This token could not be read from the network.');
  else if (token.factoryNonce === null) add('token', 'This token was not made by Aretia’s token factory, so it cannot be sold on a curve.');

  let totalRaw = 0n;
  if (token !== null) {
    const raw = toSmallestUnit(form.tokenAmount.replace(/,/g, '').trim(), token.decimals);
    if (raw === null || BigInt(raw) <= 0n) add('tokenAmount', 'A number above zero, with no more decimal places than the token has.');
    else {
      totalRaw = BigInt(raw);
      if (totalRaw > token.held) add('tokenAmount', 'More than your wallet holds of this token.');
      else if (totalRaw > EVM_MAX_TOTAL) add('tokenAmount', 'More than a curve can hold.');
    }
  }

  const target = coinToWei(form.target);
  if (target === null) add('target', 'An amount above zero, with at most 18 decimal places.');
  else if (target < EVM_MIN_TARGET_WEI) add('target', `At least ${fromSmallestUnit(EVM_MIN_TARGET_WEI, 18)}.`);
  else if (target > EVM_MAX_TARGET_WEI) add('target', 'More than a curve can raise.');

  let firstBuy = 0n;
  if (form.firstBuy.trim() !== '') {
    const fb = coinToWei(form.firstBuy);
    if (fb === null) add('firstBuy', 'An amount above zero, or leave it empty.');
    else firstBuy = fb;
  }

  const derived = totalRaw > 0n && target !== null ? evmDerive(totalRaw, target) : null;
  if (totalRaw > 0n && target !== null && target >= EVM_MIN_TARGET_WEI && derived === null && issues.length === 0) add('form', 'These numbers cannot be split between a curve and a pool. Try more tokens or a different target.');

  if (issues.length > 0 || !chain || token === null || token.factoryNonce === null || target === null || derived === null) return { ok: false, issues };
  return {
    ok: true,
    config: { chain, creator: creator.toLowerCase(), token: token.address, tokenSymbol: token.symbol, tokenDecimals: token.decimals, tokenSupply: token.supply, factoryNonce: token.factoryNonce, totalRaw, targetWei: target, firstBuyWei: firstBuy, derived },
  };
}

export interface EvmCurvePreview {
  curveTokens: bigint;
  lpTokens: bigint;
  startPrice: string;
  endPrice: string;
  startValue: string;
  endValue: string;
  priceMultiple: string;
}

/** The numbers shown while still typing. Null until the token, the amount and the target all give a usable curve. */
export function evmCurvePreview(form: Pick<EvmCurveForm, 'tokenAmount' | 'target'>, token: Pick<EvmCurveToken, 'decimals' | 'supply'> | null): EvmCurvePreview | null {
  if (!token) return null;
  const raw = toSmallestUnit(form.tokenAmount.replace(/,/g, '').trim(), token.decimals);
  const target = coinToWei(form.target);
  if (raw === null || BigInt(raw) <= 0n || target === null) return null;
  const d = evmDerive(BigInt(raw), target);
  if (!d) return null;
  const start = { vSol: d.vSol0, vTok: d.vTok0 };
  const end = { vSol: d.vSol0 + target, vTok: d.vTok0 - d.curveTokens };
  const value = (m: { vSol: bigint; vTok: bigint }) => fromSmallestUnit((m.vSol * token.supply) / m.vTok, 18);
  const num = end.vSol * d.vTok0 * 10n;
  const den = d.vSol0 * end.vTok;
  const multiple = ((2n * num + den) / (2n * den)).toString();
  return {
    curveTokens: d.curveTokens,
    lpTokens: d.lpTokens,
    startPrice: evmPriceText(start, token.decimals),
    endPrice: evmPriceText(end, token.decimals),
    startValue: value(start),
    endValue: value(end),
    priceMultiple: `${multiple.slice(0, -1) || '0'}.${multiple.slice(-1)}`,
  };
}

export function evmCurveDisclosures(kind: 'create' | 'buy' | 'sell' | 'graduate' | 'abort' | 'rescue', symbol: string): { severity: 'info' | 'caution'; text: string }[] {
  const unaudited = { severity: 'caution' as const, text: 'The curve contract is new and has not been independently audited. Do not put in more than you can lose entirely.' };
  const fee = { severity: 'info' as const, text: `Aretia takes ${EVM_FEE_BPS / 100}% of the ${symbol} side of every trade, paid in the same transaction. Nothing else is taken.` };
  switch (kind) {
    case 'create':
      return [
        { severity: 'info', text: 'Two transactions: first you approve exactly the tokens going in, then the curve takes them. Only the curve contract can move them afterwards: sold to buyers along the curve, or put into the pool when it closes. You cannot take them back out.' },
        { severity: 'info', text: `When every token on the curve is sold, the ${symbol} raised and the tokens set aside open a liquidity pool, and the pool’s liquidity is locked for good.` },
        { severity: 'caution', text: 'If nobody buys, the curve stays open. Anyone who bought can sell back to it, at the price of the curve, minus the fee each way.' },
        fee,
        unaudited,
      ];
    case 'buy':
      return [
        { severity: 'info', text: `You pay the ${symbol} amount above. The price rises as tokens sell, and the page shows the least you will accept. If your payment would buy more than is left, only what is left is bought and the rest is sent back.` },
        { severity: 'caution', text: 'You can sell back while the curve is open, but you get back less than you paid: the fee is taken each way, and the price may have moved.' },
        fee,
        unaudited,
      ];
    case 'sell':
      return [{ severity: 'info', text: 'Two transactions: first you approve exactly the tokens you are selling, then the curve takes them and pays you at its current price, less the fee. The page shows the least you will accept.' }, fee, unaudited];
    case 'graduate':
      return [
        { severity: 'info', text: `Anyone can do this once the curve has sold out. It puts the ${symbol} raised and the pool tokens into the exchange as a new pool and sends the liquidity to the dead address, so nobody can ever take it out.` },
        { severity: 'caution', text: 'Creating the pool costs a lot of network gas, and you pay it. If a pool for this token already exists at another price this fails; after seven days anyone can unwind the curve so holders can sell back.' },
        unaudited,
      ];
    case 'abort':
      return [{ severity: 'info', text: 'The curve sold out but never moved into a pool. This reopens selling (not buying), so holders can sell back along the curve.' }, unaudited];
    case 'rescue':
      return [
        { severity: 'info', text: `Someone made this token's pool on the exchange before the curve could, and left a few coins or tokens in it, which blocks the normal move into a pool. Aretia's rescue helper repairs that pool to the curve's own price and moves the curve into it, all in one transaction, so nobody can block it again in between.` },
        { severity: 'info', text: `You pay at most the ${symbol} and tokens shown. Anything not needed comes back to you in the same transaction, and so does anything the repair takes out of the pre-made pool. The curve's own checks still apply: it only moves into a pool at its own price.` },
        { severity: 'caution', text: 'The rescue helper is new and has not been independently audited. It holds nothing, has no owner, and can only take tokens from your own wallet, up to the amount you approve.' },
        unaudited,
      ];
  }
}

/** The page address that opens a curve: "#/launch/curve/evm/<chain>/<token>". */
export const evmCurveShareHash = (chain: string, token: string): string => `#/launch/curve/evm/${chain}/${token.toLowerCase()}`;

export function parseEvmCurveHash(hash: string): { chain: LaunchEvmChainKey; token: string } | null {
  const m = /^#\/launch\/curve\/evm\/([a-zA-Z]+)\/(0x[0-9a-fA-F]{40})$/.exec(hash.trim());
  if (!m || !chainByKey(m[1] as LaunchEvmChainKey)) return null;
  return { chain: m[1] as LaunchEvmChainKey, token: m[2]!.toLowerCase() };
}

// ---------------------------------------------------------------- a pre-made exchange pair, and the rescue helper's plan (M-4, L-12)

/** The token/wrapped-coin pair on the curve's exchange, as read before graduating. */
export interface EvmPairState {
  pair: string;
  reserveToken: bigint;
  reserveCoin: bigint;
  /** Balances above the reserves (sent but not synced). */
  unsyncedToken: bigint;
  unsyncedCoin: bigint;
}

/** Whether a pair blocks the curve's plain `graduate`: it holds anything at all, synced or not. */
export const evmPairBlocks = (p: EvmPairState | null): boolean => p !== null && (p.reserveToken > 0n || p.reserveCoin > 0n || p.unsyncedToken > 0n || p.unsyncedCoin > 0n);

/** AretiaCurveRescue.quote(token): what a rescue needs and gives right now. */
export interface EvmRescuePlan {
  pair: string;
  reserveToken: bigint;
  reserveCoin: bigint;
  finalToken: bigint;
  finalCoin: bigint;
  /** Approve this many tokens to the helper and pass it as `maxTokens`. */
  tokensIn: bigint;
  /** Send this much coin with the call. */
  coinIn: bigint;
  /** What the repair pays the caller, on top of any unused coin. */
  tokensOut: bigint;
  coinOut: bigint;
}

/** Decodes the 11-word answer of `quote(address)`. Null for anything else, or a plan that pays out on both sides. */
export function parseRescuePlan(hex: unknown): EvmRescuePlan | null {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]{704}$/.test(hex)) return null;
  const w = (i: number): bigint => BigInt('0x' + hex.slice(2 + i * 64, 2 + (i + 1) * 64));
  if (w(0) >> 160n !== 0n) return null;
  const plan = { pair: '0x' + hex.slice(2 + 24, 2 + 64).toLowerCase(), reserveToken: w(1), reserveCoin: w(2), finalToken: w(3), finalCoin: w(4), tokensIn: w(5), coinIn: w(6), tokensOut: w(7), coinOut: w(8) };
  if (plan.tokensOut > 0n && plan.coinOut > 0n) return null;
  return plan;
}
