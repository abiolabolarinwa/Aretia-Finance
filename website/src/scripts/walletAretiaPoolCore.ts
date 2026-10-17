/**
 * Aretia Pool on the web wallet: the rules for opening a pool on Aretia's own swap program, with no network access and no keys.
 *
 * The program is program/aretia-pool (design record: docs/ARETIA_POOL.md). It is UNAUDITED and runs on devnet only. This file holds
 * the web side of the same arithmetic in BigInt, written to match the Rust crate `pool-math` exactly: __fixtures__/aretiaPoolVectors.json
 * is printed by the Rust code and replayed against this one in the tests. If the two ever disagree the Rust is right and this is a bug.
 *
 * Two things keep this off mainnet: the build flag PUBLIC_ARETIA_POOL_ENABLED, and the mainnet program address below, which is
 * deliberately empty. The form, the token rules and the disclosures are the same as for the Meteora pool (walletPoolCore.ts).
 */
import { fromSmallestUnit } from './walletTools';
import { DEFAULT_POOL_FORM, POOL_FEE_ADDRESS, POOL_FEE_LAMPORTS, validatePool, type PoolConfig, type PoolForm, type PoolIssue, type PoolToken } from './walletPoolCore';

export const ARETIA_POOL_PROGRAM_ID_DEVNET = '4EBVWVYhHSo2MZUKfEV32JqcJ2jEorZbRagY63H4pGmc';
/** Empty on purpose: set only after the program is deployed to mainnet under its own id, verified byte for byte, and the owner says go. */
export const ARETIA_POOL_PROGRAM_ID_MAINNET: string | null = null;

/** The build flag. Anything but the exact text "1" is off. */
export function aretiaPoolFlagOn(flag: string | undefined): boolean {
  return flag === '1';
}

/** The program to talk to on a cluster, or null when there is none (mainnet today). */
export function aretiaPoolProgramFor(cluster: 'mainnet' | 'devnet'): string | null {
  return cluster === 'devnet' ? ARETIA_POOL_PROGRAM_ID_DEVNET : ARETIA_POOL_PROGRAM_ID_MAINNET;
}

/** Aretia's flat creation fee and where it goes: the same as the Meteora flow, but taken by the program. */
export const ARETIA_POOL_FEE_LAMPORTS = POOL_FEE_LAMPORTS;
export const ARETIA_POOL_FEE_ADDRESS = POOL_FEE_ADDRESS;
/** Aretia's share of every trading fee, in basis points of the fee. */
export const PROTOCOL_SHARE_BPS = 2_000n;
export const MIN_TOKENS = 1_000n;
export const MIN_LIQUIDITY = 10_000_000n;
export const MIN_LIQUIDITY_DELTA = 1_000n;
export const MAX_AMOUNT = 1n << 62n;
export const ALLOWED_FEE_BPS: readonly number[] = [25, 100];
export const MAX_SNIPER_BPS = 2_500;
export const MAX_DECAY_SECS = 3_600;

/** The launch-protection choices the page offers: the fee a pool starts at (basis points) and how long it takes to fall to the base fee. */
export const LAUNCH_PROTECTION = {
  off: { startBps: 0, decaySecs: 0, label: 'None' },
  standard: { startBps: 1_000, decaySecs: 300, label: 'Standard: starts at 10%, falls to the trading fee over 5 minutes' },
  strong: { startBps: 2_500, decaySecs: 900, label: 'Strong: starts at 25%, falls to the trading fee over 15 minutes' },
} as const;
export type LaunchProtection = keyof typeof LAUNCH_PROTECTION;
/** Rent of the pool account, the position, the SOL vault and the token vault, plus the network fee: a starting estimate, deliberately high. */
export const ARETIA_POOL_NETWORK_ESTIMATE_LAMPORTS = 10_000_000n;
export const ARETIA_SLIPPAGE_BPS_DEFAULT = 100;

const BPS = 10_000n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MASK = (1n << 128n) - 1n;

// ---------------------------------------------------------------- the maths (mirrors pool-math)

export interface PoolMath {
  /** Launch protection, kept with the pool so a quote can use the fee in force. Absent means none. */
  feeStartBps?: number;
  decaySecs?: number;
  startTs?: bigint;
  x: bigint;
  y: bigint;
  l: bigint;
  feeBps: number;
  acc: bigint;
  feeReserve: bigint;
}

const ceilDiv = (a: bigint, b: bigint): bigint => a / b + (a % b === 0n ? 0n : 1n);
export const feeUp = (amount: bigint, bps: number): bigint => ceilDiv(amount * BigInt(bps), BPS);
export const protocolPart = (fee: bigint): bigint => (fee * PROTOCOL_SHARE_BPS) / BPS;

export function openPool(x0: bigint, y0: bigint, l0: bigint, feeBps: number): PoolMath | null {
  if (!ALLOWED_FEE_BPS.includes(feeBps) || x0 < MIN_TOKENS || l0 < MIN_LIQUIDITY) return null;
  if (x0 > MAX_AMOUNT || y0 > MAX_AMOUNT || l0 > MAX_AMOUNT) return null;
  return { x: x0, y: y0, l: l0, feeBps, acc: 0n, feeReserve: 0n };
}

const bigY = (p: PoolMath): bigint => p.y + p.l;
const inRange = (p: PoolMath): boolean => bigY(p) <= U64_MAX && p.x > 0n && p.l > 0n;

function credit(p: PoolMath, fee: bigint): { next: PoolMath; protocol: bigint } {
  const protocol = protocolPart(fee);
  const lp = fee - protocol;
  const perShare = (lp << 64n) / p.l;
  return { next: { ...p, acc: (p.acc + perShare) & U128_MASK, feeReserve: p.feeReserve + lp }, protocol };
}

export interface BuyResult {
  gross: bigint;
  fee: bigint;
  protocol: bigint;
  net: bigint;
  tokensOut: bigint;
}
export function buy(p: PoolMath, gross: bigint): { result: BuyResult; next: PoolMath } | null {
  if (!inRange(p) || gross <= 0n) return null;
  let fee = feeUp(gross, p.feeBps);
  if (fee > gross) fee = gross;
  const net = gross - fee;
  if (net === 0n) return null;
  const newY = bigY(p) + net;
  if (newY > U64_MAX) return null;
  const newX = ceilDiv(p.x * bigY(p), newY);
  const out = p.x - newX;
  if (out <= 0n || newX === 0n) return null;
  const { next, protocol } = credit({ ...p, x: newX, y: p.y + net }, fee);
  return { result: { gross, fee, protocol, net, tokensOut: out }, next };
}

export interface SellResult {
  gross: bigint;
  fee: bigint;
  protocol: bigint;
  net: bigint;
}
export function sell(p: PoolMath, tokensIn: bigint): { result: SellResult; next: PoolMath } | null {
  if (!inRange(p) || tokensIn <= 0n) return null;
  const newX = p.x + tokensIn;
  if (newX > U64_MAX) return null;
  const newY = ceilDiv(p.x * bigY(p), newX);
  const gross = bigY(p) - newY;
  if (gross <= 0n || gross > p.y) return null;
  let fee = feeUp(gross, p.feeBps);
  if (fee > gross) fee = gross;
  const { next, protocol } = credit({ ...p, x: newX, y: p.y - gross }, fee);
  return { result: { gross, fee, protocol, net: gross - fee }, next };
}

export function addLiquidity(p: PoolMath, dl: bigint): { tokensIn: bigint; solIn: bigint; next: PoolMath } | null {
  if (!inRange(p) || dl < MIN_LIQUIDITY_DELTA) return null;
  const dx = ceilDiv(p.x * dl, p.l);
  const dy = ceilDiv(p.y * dl, p.l);
  const next = { ...p, x: p.x + dx, y: p.y + dy, l: p.l + dl };
  if (next.x > MAX_AMOUNT || next.y > MAX_AMOUNT || next.l > MAX_AMOUNT || !inRange(next)) return null;
  return { tokensIn: dx, solIn: dy, next };
}

export function removeLiquidity(p: PoolMath, dl: bigint): { tokensOut: bigint; solOut: bigint; next: PoolMath } | null {
  if (p.l === 0n || dl <= 0n || dl > p.l || (dl < MIN_LIQUIDITY_DELTA && dl !== p.l)) return null;
  const dx = (p.x * dl) / p.l;
  const dy = (p.y * dl) / p.l;
  return { tokensOut: dx, solOut: dy, next: { ...p, x: p.x - dx, y: p.y - dy, l: p.l - dl } };
}

/** `shares * (acc - checkpoint) >> 64`, rounded down, with the difference taken modulo 2^128. Null if it does not fit u64. */
export function pendingFee(shares: bigint, acc: bigint, checkpoint: bigint): bigint | null {
  const diff = (acc - checkpoint) & U128_MASK;
  const v = (shares * diff) >> 64n;
  return v > U64_MAX ? null : v;
}

/** The fee in force `now` (unix seconds): the launch schedule falls in a line to the base fee; the part above the base is rounded up. */
export function effectiveFeeBps(baseBps: number, startBps: number, decaySecs: number, startTs: bigint, now: bigint): number {
  if (decaySecs === 0 || startBps <= baseBps) return baseBps;
  const elapsed = now > startTs ? now - startTs : 0n;
  if (elapsed >= BigInt(decaySecs)) return baseBps;
  const left = BigInt(decaySecs) - elapsed;
  const extra = ceilDiv(BigInt(startBps - baseBps) * left, BigInt(decaySecs));
  return baseBps + Number(extra);
}

/** The pool as a trade would find it at `now`: its fee is the one in force. */
export function atTime(p: PoolMath, now: bigint): PoolMath {
  return { ...p, feeBps: effectiveFeeBps(p.feeBps, p.feeStartBps ?? 0, p.decaySecs ?? 0, p.startTs ?? 0n, now) };
}

export function scheduleOk(baseBps: number, startBps: number, decaySecs: number): boolean {
  if (startBps === 0 && decaySecs === 0) return true;
  return decaySecs > 0 && decaySecs <= MAX_DECAY_SECS && startBps > baseBps && startBps <= MAX_SNIPER_BPS;
}

// ---------------------------------------------------------------- creating a pool

/** What `create_pool` is called with, worked out from what the creator chose. */
export interface CreateParams {
  creator: string;
  mint: string;
  x0: bigint;
  y0: bigint;
  l0: bigint;
  feeBps: number;
  lock: boolean;
  /** Launch protection: the fee starts here and falls to feeBps over decaySecs. Both zero means none. */
  sniperBps: number;
  decaySecs: number;
}

/**
 * The opening liquidity that puts the starting price where the creator asked: l0 = x0 * price, where the price is SOL per whole
 * token as exact decimal text (up to 12 places). Rounded down. For a pool with no SOL in it the starting price is exactly l0 / x0.
 */
export function liquidityForPrice(tokenAmountRaw: bigint, decimals: number, price: string): bigint | null {
  const m = /^(\d{1,9})(?:\.(\d{1,12}))?$/.exec(price);
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(12, '0');
  const priceUnits = BigInt(m[1]! + frac); // price * 10^12
  // lamports per raw unit = price * 10^9 / 10^decimals = priceUnits * 10^9 / (10^12 * 10^decimals)
  return (tokenAmountRaw * priceUnits) / (1000n * 10n ** BigInt(decimals));
}

/** The Meteora form plus the lock choice, which this pool offers (the Meteora flow always locks). Locked is the default. */
export type AretiaPoolForm = PoolForm & { lockLiquidity: boolean; launchProtection: LaunchProtection };
export const DEFAULT_ARETIA_POOL_FORM: AretiaPoolForm = { ...DEFAULT_POOL_FORM, lockLiquidity: true, launchProtection: 'standard' };

export type AretiaPoolValidation = { ok: true; config: PoolConfig; params: CreateParams } | { ok: false; issues: PoolIssue[] };

/** The Meteora form's rules, plus the limits of this program on amount and price. */
export function validateAretiaPool(form: AretiaPoolForm, creator: string, token: PoolToken | null): AretiaPoolValidation {
  const base = validatePool(form, creator, token);
  if (!base.ok) return base;
  // The Meteora form always locks; this pool honours the choice on the form (locked is the default).
  const config = { ...base.config, lockLiquidity: form.lockLiquidity };
  const issues: PoolIssue[] = [];
  const l0 = liquidityForPrice(config.tokenAmountRaw, config.decimals, config.price);
  if (config.tokenAmountRaw < MIN_TOKENS || config.tokenAmountRaw > MAX_AMOUNT) issues.push({ field: 'tokenAmount', message: 'The amount is outside what an Aretia pool can hold.' });
  if (l0 === null || l0 < MIN_LIQUIDITY) issues.push({ field: 'price', message: 'Amount times price must be worth at least 0.01 SOL.' });
  else if (l0 > MAX_AMOUNT) issues.push({ field: 'price', message: 'Amount times price is above what an Aretia pool can hold.' });
  if (issues.length > 0 || l0 === null) return { ok: false, issues };
  const lp = LAUNCH_PROTECTION[form.launchProtection] ?? LAUNCH_PROTECTION.off;
  const sched = config.tradingFeeBps >= lp.startBps ? { startBps: 0, decaySecs: 0 } : lp; // a schedule must start above the trading fee
  return { ok: true, config, params: { creator, mint: config.mint, x0: config.tokenAmountRaw, y0: 0n, l0, feeBps: config.tradingFeeBps, lock: config.lockLiquidity, sniperBps: sched.startBps, decaySecs: sched.decaySecs } };
}

export interface AretiaPoolCost {
  aretiaFee: bigint;
  network: bigint;
  total: bigint;
}
export function aretiaPoolCost(network: bigint): AretiaPoolCost {
  return { aretiaFee: ARETIA_POOL_FEE_LAMPORTS, network, total: ARETIA_POOL_FEE_LAMPORTS + network };
}

/** Plain-language consequences, shown before signing. Never says a pool is safe. */
export function aretiaPoolDisclosures(params: CreateParams): { severity: 'info' | 'caution'; text: string }[] {
  const feeText = params.feeBps === 25 ? '0.25%' : '1%';
  return [
    { severity: 'caution', text: 'This pool runs on Aretia’s own pool program. It has not been independently audited. It is live on a test network only.' },
    params.lock
      ? { severity: 'info', text: 'The liquidity is locked for good. Nobody, you included, can take the tokens or the SOL back out of the pool. You can still claim your share of its trading fees.' }
      : { severity: 'caution', text: 'The liquidity is not locked. You can remove it at any time, which would leave holders with no market.' },
    { severity: 'info', text: `Every trade pays ${feeText} in SOL. Aretia keeps 20% of that fee and you keep the other 80%, which you claim from the pool.` },
    params.sniperBps > 0
      ? { severity: 'info', text: `For the first ${params.decaySecs / 60} minutes after the pool opens the fee starts at ${params.sniperBps / 100}% and falls in a straight line to ${feeText}. Fast bots pay it; Aretia and you split it the same 20% / 80%.` }
      : { severity: 'caution', text: 'There is no launch protection: from the first second, trades pay only the trading fee.' },
    { severity: 'info', text: 'Only your tokens go in. Nobody can sell below the starting price, and buyers pay SOL that builds the other side of the pool.' },
    { severity: 'caution', text: 'The starting price is yours to choose and is not checked against any market. A price set far from what people will pay can leave the pool with no buyers.' },
    { severity: 'caution', text: 'Jupiter and other aggregators do not route to this pool yet. People can trade it on Aretia only.' },
  ];
}

// ---------------------------------------------------------------- reading accounts

export interface PoolAccount {
  bump: number;
  solBump: number;
  mint: string;
  creator: string;
  feeBps: number;
  x: bigint;
  y: bigint;
  l: bigint;
  acc: bigint;
  feeReserve: bigint;
  createdAt: bigint;
  feeStartBps: number;
  decaySecs: number;
}

export interface PositionAccount {
  pool: string;
  owner: string;
  shares: bigint;
  locked: bigint;
  checkpoint: bigint;
  pending: bigint;
  recipient: string;
}

/** Anchor account tags: sha256("account:Pool")[0..8] and sha256("account:Position")[0..8]. */
export const POOL_TAG = Uint8Array.from([241, 154, 109, 4, 17, 177, 109, 188]);
export const POSITION_TAG = Uint8Array.from([170, 188, 143, 228, 122, 64, 247, 208]);
export const POOL_ACCOUNT_SIZE = 8 + 1 + 1 + 32 + 32 + 2 + 8 + 8 + 8 + 16 + 8 + 8 + 2 + 4;
export const POSITION_ACCOUNT_SIZE = 8 + 32 + 32 + 8 + 8 + 16 + 8 + 32;

const u64At = (v: DataView, at: number): bigint => v.getBigUint64(at, true);
const u128At = (v: DataView, at: number): bigint => u64At(v, at) | (u64At(v, at + 8) << 64n);
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** `toBase58` is passed in so this file needs no library: tests and the card give it web3's. */
export function parsePoolAccount(data: Uint8Array, toBase58: (bytes: Uint8Array) => string): PoolAccount | null {
  if (data.length !== POOL_ACCOUNT_SIZE || !sameBytes(data.subarray(0, 8), POOL_TAG)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    bump: data[8]!,
    solBump: data[9]!,
    mint: toBase58(data.subarray(10, 42)),
    creator: toBase58(data.subarray(42, 74)),
    feeBps: v.getUint16(74, true),
    x: u64At(v, 76),
    y: u64At(v, 84),
    l: u64At(v, 92),
    acc: u128At(v, 100),
    feeReserve: u64At(v, 116),
    createdAt: BigInt.asIntN(64, u64At(v, 124)),
    feeStartBps: v.getUint16(132, true),
    decaySecs: v.getUint32(134, true),
  };
}

export function parsePositionAccount(data: Uint8Array, toBase58: (bytes: Uint8Array) => string): PositionAccount | null {
  if (data.length !== POSITION_ACCOUNT_SIZE || !sameBytes(data.subarray(0, 8), POSITION_TAG)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { pool: toBase58(data.subarray(8, 40)), owner: toBase58(data.subarray(40, 72)), shares: u64At(v, 72), locked: u64At(v, 80), checkpoint: u128At(v, 88), pending: u64At(v, 104), recipient: toBase58(data.subarray(112, 144)) };
}

export const poolMathOf = (p: PoolAccount): PoolMath => ({ x: p.x, y: p.y, l: p.l, feeBps: p.feeBps, acc: p.acc, feeReserve: p.feeReserve, feeStartBps: p.feeStartBps, decaySecs: p.decaySecs, startTs: p.createdAt });

/** What a position could claim right now, including fees not yet written to it. */
export function claimable(pool: PoolAccount, pos: PositionAccount): bigint | null {
  const owed = pendingFee(pos.shares, pool.acc, pos.checkpoint);
  return owed === null ? null : pos.pending + owed;
}

/** SOL per whole token at the pool's current price, as text with up to 12 places. */
export function priceText(pool: PoolMath, decimals: number): string {
  // SOL per whole token, times 10^12: Y lamports / x raw units * 10^decimals raw per token / 10^9 lamports per SOL * 10^12.
  const units = (bigY(pool) * 10n ** BigInt(decimals) * 1000n) / pool.x;
  return fromSmallestUnit(units, 12);
}

/** The slippage floor for a quote: `quoted * (10000 - bps) / 10000`, rounded down. */
export function minOut(quoted: bigint, slippageBps: number): bigint {
  return (quoted * (BPS - BigInt(slippageBps))) / BPS;
}
