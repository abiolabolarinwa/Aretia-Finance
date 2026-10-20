/**
 * Aretia Launch on the web wallet: the rules for selling a token on Aretia's own bonding curve, with no network access and no keys.
 *
 * The program is program/aretia-curve (design record: docs/BONDING_CURVE.md). It is UNAUDITED and runs on devnet only. This file
 * holds the web side of the same arithmetic, in BigInt, written to match the Rust crate `curve-math` exactly: __fixtures__/
 * curveVectors.json is printed by the Rust code and replayed against this one in the tests. If the two ever disagree the
 * Rust is right and this is a bug.
 *
 * Two things keep this off mainnet until it has been audited: the build flag PUBLIC_CURVE_ENABLED, and the mainnet program
 * address below, which is deliberately empty.
 */
import { isSolanaAddress, toSmallestUnit, fromSmallestUnit } from './walletTools';
import { LAUNCH_FEE_ADDRESS } from './walletLaunchCore';
import { tokenBlockers, type PoolToken } from './walletPoolCore';
import type * as Web3 from '@solana/web3.js';

export const CURVE_PROGRAM_ID_DEVNET = '9HVuUHU4mm6PYZFRnY7KzuGsHVSZ8QUVavarJLpJt5f4';
/**
 * The id the committed program build is made for (`declare_id!` in the program). It is the owner's own program key, made for mainnet.
 * It is NOT used for anything until the program is deployed and `scripts/curve-solana-mainnet.mjs verify` passes; then it is copied below.
 */
export const CURVE_PROGRAM_ID_MAINNET_PLANNED = 'CCBr6DtydkC83FFoU1Hh3nCdsdsUsqeVsDy8H7UqtVBu';
/** Empty on purpose: set only after the program is deployed to mainnet, verified byte for byte, and the owner says go. */
export const CURVE_PROGRAM_ID_MAINNET: string | null = null;

/** Fee on every trade, in basis points of the SOL side. The owner set it at 0.58%; it is also a constant in the program. */
export const CURVE_FEE_BPS = 58;
export const CURVE_FEE_ADDRESS = LAUNCH_FEE_ADDRESS;
export const CURVE_MIN_TARGET_LAMPORTS = 100_000_000n;
export const CURVE_MAX_TARGET_LAMPORTS = 1_000_000_000_000_000n;
export const CURVE_MAX_TOTAL_TOKENS = 1n << 62n;
export const CURVE_ABORT_AFTER_SECS = 7 * 24 * 60 * 60;
export const CURVE_MAX_RENT_BUDGET = 200_000_000n;
/** What the pool's accounts cost to create, as a starting estimate before the trial run measures it. */
export const MIGRATE_RENT_ESTIMATE_LAMPORTS = 60_000_000n;
/** Rent of the curve account, its SOL vault and its token vault: a starting estimate before the trial run measures it. */
export const CREATE_NETWORK_ESTIMATE_LAMPORTS = 12_000_000n;
export const SLIPPAGE_BPS_DEFAULT = 100;

const BPS = 10_000n;
const U64_MAX = (1n << 64n) - 1n;
const MIGRATION_DUST_BPS = 10n;

/** Meteora's price bounds, as written in its program. */
export const MIN_SQRT_PRICE = 4_295_048_016n;
export const MAX_SQRT_PRICE = 79_226_673_521_066_979_257_578_248_091n;

/** The build flag. Anything but the exact text "1" is off. */
export function curveFlagOn(flag: string | undefined): boolean {
  return flag === '1';
}

/** The program to talk to on a cluster, or null when there is none (mainnet today). */
export function curveProgramFor(cluster: 'mainnet' | 'devnet'): string | null {
  return cluster === 'devnet' ? CURVE_PROGRAM_ID_DEVNET : CURVE_PROGRAM_ID_MAINNET;
}

// ---------------------------------------------------------------- the maths (mirrors curve-math)

export interface CurveMath {
  vSol: bigint;
  vTok: bigint;
  /** Lamports the vault owes holders, net of fees. */
  realSol: bigint;
  /** Tokens still for sale. */
  realTok: bigint;
}

export interface Derived {
  vSol0: bigint;
  vTok0: bigint;
  curveTokens: bigint;
  lpTokens: bigint;
}

const ceilDiv = (a: bigint, b: bigint): bigint => a / b + (a % b === 0n ? 0n : 1n);
export const feeUp = (amount: bigint, bps: number): bigint => ceilDiv(amount * BigInt(bps), BPS);

/** Splits `total` tokens between the curve and the pool and sets the starting reserves. Null outside the safe range. */
export function deriveCurve(total: bigint, target: bigint, minTarget: bigint = CURVE_MIN_TARGET_LAMPORTS): Derived | null {
  if (total <= 0n || total > CURVE_MAX_TOTAL_TOKENS) return null;
  if (target < minTarget || target > CURVE_MAX_TARGET_LAMPORTS) return null;
  const vSol0 = (target * 6n) / 17n;
  if (vSol0 === 0n) return null;
  const lp = (total * vSol0) / (2n * vSol0 + target);
  const c = total - lp;
  if (lp === 0n || c === 0n) return null;
  const vTok0 = ceilDiv((vSol0 + target) * c, target);
  if (vTok0 > U64_MAX || vTok0 <= c) return null;
  return { vSol0, vTok0, curveTokens: c, lpTokens: lp };
}

export const startOf = (d: Derived): CurveMath => ({ vSol: d.vSol0, vTok: d.vTok0, realSol: 0n, realTok: d.curveTokens });

export interface BuyQuote {
  gross: bigint;
  fee: bigint;
  net: bigint;
  tokensOut: bigint;
  soldOut: boolean;
  next: CurveMath;
}

/** Exact-input buy, as the program does it: fee up and first, tokens down, an oversized offer cut to what is left and priced up. */
export function quoteBuy(c: CurveMath, offered: bigint, feeBps: number): BuyQuote | null {
  if (feeBps < 0 || BigInt(feeBps) >= BPS || offered <= 0n || offered > U64_MAX) return null;
  const fee = feeUp(offered, feeBps) < offered ? feeUp(offered, feeBps) : offered;
  const net = offered - fee;
  if (net === 0n || c.realTok === 0n) return null;
  const k = c.vSol * c.vTok;
  const newVs = c.vSol + net;
  const newVt = ceilDiv(k, newVs);
  const out = c.vTok - newVt;
  let netUsed = net;
  let grossUsed = offered;
  let feeUsed = fee;
  let tokensOut = out;
  if (out >= c.realTok) {
    const targetVt = c.vTok - c.realTok;
    if (targetVt === 0n) return null;
    const needVs = ceilDiv(k, targetVt);
    netUsed = needVs - c.vSol;
    grossUsed = ceilDiv(netUsed * BPS, BPS - BigInt(feeBps));
    feeUsed = grossUsed - netUsed;
    tokensOut = c.realTok;
  }
  if (tokensOut === 0n || grossUsed > offered || netUsed > U64_MAX) return null;
  const next: CurveMath = { vSol: c.vSol + netUsed, vTok: c.vTok - tokensOut, realSol: c.realSol + netUsed, realTok: c.realTok - tokensOut };
  if (next.realSol > U64_MAX) return null;
  return { gross: grossUsed, fee: feeUsed, net: netUsed, tokensOut, soldOut: next.realTok === 0n, next };
}

export interface SellQuote {
  /** Lamports leaving the vault. */
  gross: bigint;
  fee: bigint;
  /** What the seller receives. */
  net: bigint;
  next: CurveMath;
}

/** Exact-input sell: SOL down, fee up. Refuses to put back more tokens than the curve has sold, or to pay the seller nothing. */
export function quoteSell(c: CurveMath, curveTokens: bigint, tokensIn: bigint, feeBps: number): SellQuote | null {
  if (feeBps < 0 || BigInt(feeBps) >= BPS || tokensIn <= 0n || tokensIn > U64_MAX) return null;
  const realTok = c.realTok + tokensIn;
  if (realTok > curveTokens) return null;
  const k = c.vSol * c.vTok;
  const newVt = c.vTok + tokensIn;
  const newVs = ceilDiv(k, newVt);
  const gross = c.vSol - newVs;
  if (gross < 0n || gross > c.realSol) return null;
  const fee = feeUp(gross, feeBps) < gross ? feeUp(gross, feeBps) : gross;
  // The program refuses a sell that would pay the seller nothing after the fee (the tokens would be lost).
  if (gross === fee) return null;
  return { gross, fee, net: gross - fee, next: { vSol: newVs, vTok: newVt, realSol: c.realSol - gross, realTok } };
}

/** Lamports per one whole token at the curve's current marginal price (the next lamport buys at about this). */
export function priceLamportsPerToken(c: Pick<CurveMath, 'vSol' | 'vTok'>, decimals: number): bigint {
  return (c.vSol * 10n ** BigInt(decimals)) / c.vTok;
}

const isqrt = (n: bigint): bigint => {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
};

/**
 * What the pool is opened with. `sqrtPrice` is sqrt(sol / tokens) in Q64.64; `liquidity` is the largest amount both sides can fund
 * over Meteora's full price range, less one unit so rounding inside Meteora can never ask for more than there is. The program does
 * not trust either number: it reverts unless the pool took all but 0.1% of both sides.
 */
export function migrationArgs(realSol: bigint, lpTokens: bigint): { liquidity: bigint; sqrtPrice: bigint } | null {
  if (realSol <= 0n || lpTokens <= 0n) return null;
  const p = isqrt((realSol << 128n) / lpTokens);
  if (p <= MIN_SQRT_PRICE || p >= MAX_SQRT_PRICE) return null;
  const la = (lpTokens * p * MAX_SQRT_PRICE) / (MAX_SQRT_PRICE - p);
  const lb = (realSol << 128n) / (p - MIN_SQRT_PRICE);
  const l = (la < lb ? la : lb) - 1n;
  if (l <= 0n) return null;
  return { liquidity: l, sqrtPrice: p };
}

/** The program's rule for what a pool may leave unspent: at most 0.1% of what this migration put in. */
export const leftoverAllowed = (reserved: bigint, leftOver: bigint): boolean => leftOver * BPS <= reserved * MIGRATION_DUST_BPS;

// ---------------------------------------------------------------- creating a curve

export interface CurveForm {
  mint: string;
  /** Whole tokens, commas allowed: all that go into the curve and the pool. */
  tokenAmount: string;
  /** SOL the curve should raise, plain decimal. */
  target: string;
  /** Optional SOL the creator buys with in the same transaction. Empty for none. */
  firstBuy: string;
}

export const DEFAULT_CURVE_FORM: CurveForm = { mint: '', tokenAmount: '', target: '85', firstBuy: '' };

export interface CurveConfig {
  creator: string;
  mint: string;
  decimals: number;
  totalRaw: bigint;
  targetLamports: bigint;
  firstBuyLamports: bigint;
  derived: Derived;
}

export interface CurveIssue {
  field: keyof CurveForm | 'form';
  message: string;
}

export type CurveValidation = { ok: true; config: CurveConfig } | { ok: false; issues: CurveIssue[] };

/** "85" or "0.5" -> lamports. Null unless a plain positive decimal with at most 9 places. */
export function solToLamports(text: string): bigint | null {
  const raw = toSmallestUnit(text.replace(/,/g, '').trim(), 9);
  if (raw === null) return null;
  const v = BigInt(raw);
  return v > 0n ? v : null;
}

export function validateCurve(form: CurveForm, creator: string, token: PoolToken | null): CurveValidation {
  const issues: CurveIssue[] = [];
  const add = (field: CurveIssue['field'], message: string) => issues.push({ field, message });

  if (!isSolanaAddress(creator)) add('form', 'Connect a wallet first.');
  if (!isSolanaAddress(form.mint.trim())) add('mint', 'A valid token address.');
  else if (token === null) add('mint', 'This token could not be read from the network, or it is not a Token-2022 token.');
  else for (const b of tokenBlockers(token)) add('mint', b);

  let totalRaw = 0n;
  if (token !== null) {
    const raw = toSmallestUnit(form.tokenAmount.replace(/,/g, '').trim(), token.decimals);
    if (raw === null || BigInt(raw) <= 0n) add('tokenAmount', 'A number above zero, with no more decimal places than the token has.');
    else {
      totalRaw = BigInt(raw);
      if (totalRaw > token.held) add('tokenAmount', 'More than your wallet holds of this token.');
      else if (totalRaw > CURVE_MAX_TOTAL_TOKENS) add('tokenAmount', 'More than a curve can hold.');
    }
  }

  const target = solToLamports(form.target);
  if (target === null) add('target', 'A number of SOL above zero, with at most 9 decimal places.');
  else if (target < CURVE_MIN_TARGET_LAMPORTS) add('target', `At least ${fromSmallestUnit(CURVE_MIN_TARGET_LAMPORTS, 9)} SOL.`);
  else if (target > CURVE_MAX_TARGET_LAMPORTS) add('target', 'More than a curve can raise.');

  let firstBuy = 0n;
  if (form.firstBuy.trim() !== '') {
    const fb = solToLamports(form.firstBuy);
    if (fb === null) add('firstBuy', 'A number of SOL above zero, or leave it empty.');
    else firstBuy = fb;
  }

  const derived = totalRaw > 0n && target !== null ? deriveCurve(totalRaw, target) : null;
  if (totalRaw > 0n && target !== null && target >= CURVE_MIN_TARGET_LAMPORTS && derived === null && issues.length === 0) add('form', 'These numbers cannot be split between a curve and a pool. Try more tokens or a different target.');

  if (issues.length > 0 || token === null || target === null || derived === null) return { ok: false, issues };
  return { ok: true, config: { creator, mint: token.mint, decimals: token.decimals, totalRaw, targetLamports: target, firstBuyLamports: firstBuy, derived } };
}

export interface CurveSummary {
  startPrice: string;
  endPrice: string;
  /** Everything the buyers' SOL is, in SOL, the moment the curve closes. */
  raisesAbout: string;
  /** Whole supply valued at the first and at the last curve price, in SOL. */
  startValue: string;
  endValue: string;
}

/** SOL per one whole token at a marginal price, with enough places to read a small price (18 of them, trailing zeros trimmed). */
export function priceText(c: Pick<CurveMath, 'vSol' | 'vTok'>, decimals: number): string {
  return fromSmallestUnit((c.vSol * 10n ** BigInt(decimals + 9)) / c.vTok, 18);
}

export function summarise(config: Pick<CurveConfig, 'decimals' | 'targetLamports' | 'derived'>, supply: bigint): CurveSummary {
  const d = config.derived;
  const start: Pick<CurveMath, 'vSol' | 'vTok'> = { vSol: d.vSol0, vTok: d.vTok0 };
  const end: Pick<CurveMath, 'vSol' | 'vTok'> = { vSol: d.vSol0 + config.targetLamports, vTok: d.vTok0 - d.curveTokens };
  const value = (c: Pick<CurveMath, 'vSol' | 'vTok'>) => fromSmallestUnit((c.vSol * supply) / c.vTok, 9);
  return {
    startPrice: priceText(start, config.decimals),
    endPrice: priceText(end, config.decimals),
    raisesAbout: fromSmallestUnit(config.targetLamports, 9),
    startValue: value(start),
    endValue: value(end),
  };
}

// ---------------------------------------------------------------- reading a curve back from the chain

/** First eight bytes of every curve account: sha256("account:Curve"). */
export const CURVE_ACCOUNT_DISCRIMINATOR = Uint8Array.from([191, 180, 249, 66, 180, 71, 51, 182]);
export const CURVE_ACCOUNT_SIZE = 189;

export type CurveStatus = 'trading' | 'soldOut' | 'migrated' | 'aborted';
const STATUSES: CurveStatus[] = ['trading', 'soldOut', 'migrated', 'aborted'];

export interface CurveState extends CurveMath {
  bump: number;
  solBump: number;
  status: CurveStatus;
  creator: string;
  mint: string;
  feeBps: number;
  target: bigint;
  vSol0: bigint;
  curveTokens: bigint;
  lpTokens: bigint;
  createdAt: bigint;
  soldOutAt: bigint;
  pool: string | null;
}

/** Reads a curve account. Null unless it is exactly the right size and starts with the curve discriminator. */
export function parseCurveAccount(web3: typeof Web3, owner: string, program: string, data: Uint8Array): CurveState | null {
  if (owner !== program || data.length !== CURVE_ACCOUNT_SIZE) return null;
  if (!CURVE_ACCOUNT_DISCRIMINATOR.every((b, i) => data[i] === b)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let at = 8;
  const u8 = () => data[at++]!;
  const u16 = () => {
    const x = v.getUint16(at, true);
    at += 2;
    return x;
  };
  const u64 = () => {
    const x = v.getBigUint64(at, true);
    at += 8;
    return x;
  };
  const i64 = () => {
    const x = v.getBigInt64(at, true);
    at += 8;
    return x;
  };
  const key = () => {
    const x = new web3.PublicKey(data.subarray(at, at + 32)).toBase58();
    at += 32;
    return x;
  };
  const bump = u8();
  const solBump = u8();
  const status = STATUSES[u8()];
  if (!status) return null;
  const creator = key();
  const mint = key();
  const feeBps = u16();
  const target = u64();
  const vSol0 = u64();
  const curveTokens = u64();
  const lpTokens = u64();
  const vSol = u64();
  const vTok = u64();
  const realSol = u64();
  const realTok = u64();
  const createdAt = i64();
  const soldOutAt = i64();
  const pool = key();
  return { bump, solBump, status, creator, mint, feeBps, target, vSol0, curveTokens, lpTokens, vSol, vTok, realSol, realTok, createdAt, soldOutAt, pool: pool === '11111111111111111111111111111111' ? null : pool };
}

/** The two reserve rules every curve must satisfy. A curve read back that breaks either is not shown as healthy. */
export function curveProblems(c: CurveState): string[] {
  const out: string[] = [];
  if (c.vSol - c.realSol !== c.vSol0) out.push('The curve’s reserves do not add up.');
  if (c.realTok > c.curveTokens) out.push('The curve claims more tokens for sale than it was given.');
  if (c.feeBps !== CURVE_FEE_BPS) out.push(`This curve charges ${c.feeBps / 100}%, not the ${CURVE_FEE_BPS / 100}% this page shows.`);
  return out;
}

/** Whether `migrate` may be called, and whether `abort_migration` may. */
export const canMigrate = (c: CurveState): boolean => c.status === 'soldOut' && c.realTok === 0n;
export const canAbort = (c: CurveState, nowSecs: number): boolean => c.status === 'soldOut' && BigInt(nowSecs) >= c.soldOutAt + BigInt(CURVE_ABORT_AFTER_SECS);

// ---------------------------------------------------------------- trading forms

/** Minimum a buyer will accept, `slippageBps` below the quote. */
export const minOut = (quoted: bigint, slippageBps: number): bigint => (quoted * (BPS - BigInt(slippageBps))) / BPS;

export interface TradeInput {
  sol: bigint | null;
  tokens: bigint | null;
}

/** Whole tokens text -> raw units. Null unless valid and above zero. */
export function tokensToRaw(text: string, decimals: number): bigint | null {
  const raw = toSmallestUnit(text.replace(/,/g, '').trim(), decimals);
  if (raw === null) return null;
  const v = BigInt(raw);
  return v > 0n ? v : null;
}

// ---------------------------------------------------------------- costs and plain-language notes

export interface CurveCost {
  /** Aretia's fee, in lamports, for the part of the transaction that pays it. Zero when there is none. */
  aretiaFee: bigint;
  /** Everything else the transaction takes from the wallet that is not the trade itself. */
  network: bigint;
}

export function curveDisclosures(kind: 'create' | 'buy' | 'sell' | 'migrate' | 'abort' | 'claim-fees'): { severity: 'info' | 'caution'; text: string }[] {
  const unaudited = { severity: 'caution' as const, text: 'The curve program is new and has not been independently audited. Do not put in more than you can lose entirely.' };
  const fee = { severity: 'info' as const, text: `Aretia takes ${CURVE_FEE_BPS / 100}% of the SOL side of every trade on the curve, paid in the same transaction.` };
  const poolFee = { severity: 'info' as const, text: 'Once the curve moves into its pool, that pool charges 0.25% on every trade, taken in SOL. The locked position\'s share of those fees is paid to Aretia, not to the creator or to holders. The liquidity itself stays locked for good.' };
  switch (kind) {
    case 'create':
      return [
        { severity: 'info', text: 'Your tokens move into the curve’s vault. Only the curve’s program can move them: sold to buyers along the curve, or put into the pool when it closes. You cannot take them back out.' },
        { severity: 'info', text: 'When every token on the curve is sold, the SOL raised and the tokens set aside for it open a liquidity pool, and the pool’s liquidity is locked for good.' },
        { severity: 'caution', text: 'If nobody buys, the curve stays open. Anyone who bought can sell back to it, at the price of the curve, minus the fee each way.' },
        fee,
        poolFee,
        unaudited,
      ];
    case 'buy':
      return [
        { severity: 'info', text: 'You pay at most the amount above. The price rises as tokens sell, and the page shows the least you will accept.' },
        { severity: 'caution', text: 'You can sell back at any time while the curve is open, but you get back less than you paid: the fee is taken each way, and the price may have moved.' },
        fee,
        unaudited,
      ];
    case 'sell':
      return [{ severity: 'info', text: 'You hand back tokens and receive SOL at the curve’s current price, less the fee. The page shows the least you will accept.' }, fee, unaudited];
    case 'migrate':
      return [
        { severity: 'info', text: 'Anyone can do this once the curve has sold out. It moves the raised SOL and the pool tokens into a new liquidity pool and locks it. You lend a small amount for the pool’s accounts; what is not used comes straight back.' },
        { severity: 'caution', text: 'If a pool for this token and SOL already exists, this will fail. Anyone can then unwind the curve at once so holders can sell back.' },
        poolFee,
        unaudited,
      ];
    case 'abort':
      return [{ severity: 'info', text: 'The curve sold out but never moved into a pool. This reopens selling (not buying), so holders can sell back along the curve.' }, unaudited];
    case 'claim-fees':
      return [
        { severity: 'info', text: 'This sends the trading fees the graduated pool has earned to Aretia\'s fee wallet, in wrapped SOL. Anyone can press it; the fees can go nowhere else, and you only pay the network fee.' },
        { severity: 'info', text: 'The pool\'s liquidity is not touched: it stays locked for good.' },
        unaudited,
      ];
  }
}

// ---------------------------------------------------------------- what a creator sees while typing, and sharing a curve

/** Raise targets offered as one-tap choices on the create form. */
export const CURVE_TARGET_PRESETS = ['10', '30', '85'] as const;

export interface CurvePreview extends CurveSummary {
  curveTokens: bigint;
  lpTokens: bigint;
  /** How many times dearer the last curve token is than the first. */
  priceMultiple: string;
}

/**
 * The numbers a creator is shown while still typing: how the tokens split and what the price does. Needs only the token's decimals and
 * supply, not the wallet, so it works before anything is connected. Null until the amount and the target are both usable.
 */
export function curvePreview(form: Pick<CurveForm, 'tokenAmount' | 'target'>, token: Pick<PoolToken, 'decimals' | 'supply'> | null): CurvePreview | null {
  if (!token) return null;
  const raw = toSmallestUnit(form.tokenAmount.replace(/,/g, '').trim(), token.decimals);
  const target = solToLamports(form.target);
  if (raw === null || BigInt(raw) <= 0n || target === null) return null;
  const derived = deriveCurve(BigInt(raw), target);
  if (!derived) return null;
  const s = summarise({ decimals: token.decimals, targetLamports: target, derived }, token.supply);
  const end = { vSol: derived.vSol0 + target, vTok: derived.vTok0 - derived.curveTokens };
  const num = end.vSol * derived.vTok0 * 10n;
  const den = derived.vSol0 * end.vTok;
  const multiple = ((2n * num + den) / (2n * den)).toString(); // to one decimal place, rounded to nearest
  return { ...s, curveTokens: derived.curveTokens, lpTokens: derived.lpTokens, priceMultiple: `${multiple.slice(0, -1) || '0'}.${multiple.slice(-1)}` };
}

/** Whole percent of the curve's tokens sold, rounded down; never 100 until the last one is gone. */
export function curveProgressPercent(c: Pick<CurveState, 'curveTokens' | 'realTok'>): number {
  if (c.curveTokens === 0n) return 0;
  const sold = c.curveTokens - c.realTok;
  const pct = Number((sold * 100n) / c.curveTokens);
  return c.realTok === 0n ? 100 : Math.min(pct, 99);
}

/** The part of the page address that opens a curve: "#/launch/curve/<token address>". */
export const curveShareHash = (mint: string): string => `#/launch/curve/${mint}`;

/** The token address in a page address like the one above, or null for anything else. */
export function parseCurveHash(hash: string): string | null {
  const m = /^#\/launch\/curve\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(hash.trim());
  return m && isSolanaAddress(m[1]!) ? m[1]! : null;
}
