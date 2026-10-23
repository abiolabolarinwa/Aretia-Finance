/**
 * Aretia Launch on the web wallet: the one transaction that opens a pool, and a check of it before anyone signs.
 *
 * The pool instructions come from Meteora's own SDK (pinned to one exact version in package.json): the program's account layout
 * and fee encoding change between releases, and hand-writing them would be the larger risk. What this file adds is the check. The
 * inspector reads every instruction back as raw bytes, without the SDK's builder, and refuses anything that is not exactly the
 * pool that was shown: another program, an extra transfer, a different recipient or amount, a different price, a different
 * owner for the position, an extra signer, a different fee payer.
 *
 * The transaction, in order:
 *   1. Aretia's flat fee, a plain SOL transfer
 *   2. create the creator's token account for the token if it is missing (it never is, the creator holds the token)
 *   3. create the creator's account for the other side of the pool (SOL, USDC or another token)
 *   3b. for SOL only: put one lamport in the wrapped-SOL account and sync it (the SDK does this for the quote side)
 *   4. create the pool and its position, putting the creator's tokens in, single-sided
 *   5. optionally lock the position for good
 * The position's NFT key signs alongside the wallet and is then dropped, as the new token's key is on the creation page.
 */
import type * as Web3 from '@solana/web3.js';
import type * as MeteoraSdk from '@meteora-ag/cp-amm-sdk';
import type BN from 'bn.js';
import { ATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ataAddress } from './walletTools';
import { SYSTEM_PROGRAM_ID } from './walletLaunchTx';
import { POOL_FEE_ADDRESS, POOL_FEE_LAMPORTS, WSOL_MINT, protectionSchedule, quoteOf, type PoolConfig } from './walletPoolCore';
// A function-only import (walletCurveTx imports this file's constants too): the pool address is derived without the SDK.
import { meteoraPoolAddress } from './walletCurveTx';

export const METEORA_PROGRAM_ID = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
/** Meteora's fixed pool authority (an address written into the program, the same for every pool). */
export const METEORA_POOL_AUTHORITY = 'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC';
const INIT_DISCRIMINATOR = Uint8Array.from([20, 161, 241, 24, 189, 221, 180, 2]);
const LOCK_DISCRIMINATOR = Uint8Array.from([165, 176, 125, 6, 231, 171, 186, 213]);
/** The SDK puts exactly one lamport into the wrapped-SOL account for the quote side. */
const WRAP_LAMPORTS = 1n;
/** Meteora's activation type for a pool that opens by clock time (the other is by slot). */
const ACTIVATION_TIMESTAMP = 1;

export interface PoolLibs {
  sdk: typeof MeteoraSdk;
  BN: typeof BN;
  /** The SDK's pool client. Only its offline helpers and its transaction builder are used; nothing is sent from it. */
  cpAmm: InstanceType<typeof MeteoraSdk.CpAmm>;
}

/** The numbers the pool is created with, worked out from what the creator chose. */
export interface PoolMath {
  minSqrtPrice: BN;
  maxSqrtPrice: BN;
  liquidity: BN;
  /** Meteora's 27-byte base-fee block: a flat fee, or the launch-protection schedule when the config asks for it. */
  baseFee: Uint8Array;
}

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);

/** The SDK's fee-scheduler call for a config: flat, or a straight line from the protection fee down to the creator's fee. */
function baseFeeFor(libs: PoolLibs, config: PoolConfig) {
  const { sdk } = libs;
  const p = config.launchProtection;
  const sched = p ? protectionSchedule(config.tradingFeeBps, p) : null;
  return sdk.getBaseFeeParams({
    baseFeeMode: sdk.BaseFeeMode.FeeTimeSchedulerLinear,
    feeTimeSchedulerParam: p && sched
      ? { startingFeeBps: p.startBps, endingFeeBps: config.tradingFeeBps, numberOfPeriod: sched.periods, totalDuration: p.minutes * 60 }
      : { startingFeeBps: config.tradingFeeBps, endingFeeBps: config.tradingFeeBps, numberOfPeriod: 0, totalDuration: 0 },
  });
}

/**
 * The same 27-byte block written by hand (Borsh: u64 starting fee, u16 periods, u64 period length, u64 drop per period, u8 mode 0 =
 * linear), with no SDK. The inspector compares the built transaction with this, so a wrong block from the builder is caught.
 */
export function expectedBaseFee(config: PoolConfig): Uint8Array {
  const p = config.launchProtection;
  const out = new Uint8Array(27);
  const v = view(out);
  const s = p ? protectionSchedule(config.tradingFeeBps, p) : { cliff: BigInt(config.tradingFeeBps) * 100_000n, periods: 0, frequency: 0n, reduction: 0n };
  v.setBigUint64(0, s.cliff, true);
  v.setUint16(8, s.periods, true);
  v.setBigUint64(10, s.frequency, true);
  v.setBigUint64(18, s.reduction, true);
  out[26] = 0;
  return out;
}

/** floor(sqrt(n)) for a non-negative bigint, by Newton's method. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt of a negative number');
  if (n < 2n) return n;
  let x = 1n << BigInt((n.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/**
 * The starting price as Meteora stores it, a Q64.64 square root of (the pair token's smallest units per raw token), worked out with
 * integers only and no SDK: floor(sqrt(price × 10^(quoteDecimals − decimals)) × 2^64). The pair token is SOL (9 decimals) unless told. Null when the price is not a plain decimal.
 */
export function expectedSqrtPrice(price: string, decimals: number, quoteDecimals = 9): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(price);
  if (!m || !Number.isInteger(decimals) || decimals < 0 || decimals > 30 || !Number.isInteger(quoteDecimals) || quoteDecimals < 0 || quoteDecimals > 30) return null;
  const frac = m[2] ?? '';
  let num = BigInt(m[1]! + frac) << 128n;
  let den = 10n ** BigInt(frac.length);
  if (decimals <= quoteDecimals) num *= 10n ** BigInt(quoteDecimals - decimals);
  else den *= 10n ** BigInt(decimals - quoteDecimals);
  return num === 0n ? null : isqrt(num / den);
}

/** Raw tokens a single-sided position of `liquidity` over [lower, upper] holds (Meteora's concentrated formula, rounded up). */
export function impliedTokenAmount(liquidity: bigint, lower: bigint, upper: bigint): bigint | null {
  if (lower <= 0n || upper <= lower) return null;
  const n = liquidity * (upper - lower);
  const d = lower * upper;
  return (n + d - 1n) / d;
}

export function poolMath(web3: typeof Web3, libs: PoolLibs, config: PoolConfig): PoolMath {
  const { sdk, BN: Big } = libs;
  const minSqrtPrice = sdk.getSqrtPriceFromPrice(config.price, config.decimals, quoteOf(config).decimals);
  const maxSqrtPrice = sdk.MAX_SQRT_PRICE;
  const tokenAAmount = new Big(config.tokenAmountRaw.toString());
  const mint = {
    address: new web3.PublicKey(config.mint),
    mintAuthority: null,
    supply: 0n,
    decimals: config.decimals,
    isInitialized: true,
    freezeAuthority: null,
    tlvData: Buffer.alloc(0),
  };
  const liquidity = libs.cpAmm.preparePoolCreationSingleSide({
    tokenAAmount,
    minSqrtPrice,
    maxSqrtPrice,
    initSqrtPrice: minSqrtPrice,
    tokenAInfo: { mint: mint as never, currentEpoch: 0 },
    collectFeeMode: sdk.CollectFeeMode.BothToken,
  });
  const base = baseFeeFor(libs, config);
  return { minSqrtPrice, maxSqrtPrice, liquidity, baseFee: Uint8Array.from(base.data as ArrayLike<number>) };
}

export interface BuiltPool {
  instructions: Web3.TransactionInstruction[];
  /** The pool's address, which is fixed by the two tokens. Shown on the review screen and read back afterwards. */
  pool: string;
  position: string;
  math: PoolMath;
}

export async function buildPool(web3: typeof Web3, libs: PoolLibs, config: PoolConfig, nft: string): Promise<BuiltPool> {
  const { sdk, BN: Big } = libs;
  const math = poolMath(web3, libs, config);
  const quote = quoteOf(config);
  const creator = new web3.PublicKey(config.creator);
  const { tx, pool, position } = await libs.cpAmm.createCustomPool({
    payer: creator,
    creator,
    positionNft: new web3.PublicKey(nft),
    tokenAMint: new web3.PublicKey(config.mint),
    tokenBMint: new web3.PublicKey(quote.mint),
    tokenAAmount: new Big(config.tokenAmountRaw.toString()),
    tokenBAmount: new Big(0),
    sqrtMinPrice: math.minSqrtPrice,
    sqrtMaxPrice: math.maxSqrtPrice,
    liquidityDelta: math.liquidity,
    initSqrtPrice: math.minSqrtPrice,
    poolFees: {
      baseFee: baseFeeFor(libs, config),
      compoundingFeeBps: 0,
      padding: 0,
      dynamicFee: null,
    },
    hasAlphaVault: false,
    activationType: sdk.ActivationType.Timestamp,
    collectFeeMode: sdk.CollectFeeMode.BothToken,
    activationPoint: null,
    tokenAProgram: new web3.PublicKey(TOKEN_2022_PROGRAM_ID),
    tokenBProgram: new web3.PublicKey(quote.program),
    isLockLiquidity: config.lockLiquidity,
  });
  const fee = web3.SystemProgram.transfer({ fromPubkey: creator, toPubkey: new web3.PublicKey(POOL_FEE_ADDRESS), lamports: POOL_FEE_LAMPORTS });
  // Compute-budget instructions the SDK may add are dropped: the check below allows only the instructions listed above, and the
  // wallet and network set their own limits.
  const own = tx.instructions.filter((ix) => ix.programId.toBase58() !== 'ComputeBudget111111111111111111111111111111');
  return { instructions: [fee, ...own], pool: pool.toBase58(), position: position.toBase58(), math };
}

export function assemblePool(web3: typeof Web3, instructions: Web3.TransactionInstruction[], creator: string, blockhash: string, lastValidBlockHeight: number): Web3.Transaction {
  const tx = new web3.Transaction({ feePayer: new web3.PublicKey(creator), blockhash, lastValidBlockHeight });
  tx.add(...instructions);
  return tx;
}

// ---------------------------------------------------------------- the check before signing

export interface PoolCheckInput {
  config: PoolConfig;
  /** The position NFT's address (the key the page generated for it). */
  nft: string;
  /** The pool address shown to the creator. */
  pool: string;
  math: PoolMath;
}

const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

function u128(d: Uint8Array, at: number): bigint {
  const v = view(d);
  return v.getBigUint64(at, true) | (v.getBigUint64(at + 8, true) << 64n);
}

/** Meteora's token-badge account for a mint: a fixed address the program reads to see whether a token is allowed. */
export function tokenBadge(web3: typeof Web3, mint: string): string {
  return web3.PublicKey.findProgramAddressSync([Buffer.from('token_badge'), new web3.PublicKey(mint).toBytes()], new web3.PublicKey(METEORA_PROGRAM_ID))[0].toBase58();
}
function eventAuthority(web3: typeof Web3): string {
  return web3.PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new web3.PublicKey(METEORA_PROGRAM_ID))[0].toBase58();
}

/**
 * Reads the built transaction back and compares it with what the review screen showed. Returns the reasons not to sign; empty
 * means every instruction is one of the expected ones, in order, with the expected accounts and amounts, and the only accounts
 * that must sign are the creator and the position's NFT key.
 */
export function inspectPool(web3: typeof Web3, tx: Web3.Transaction, input: PoolCheckInput): string[] {
  const { config, nft, pool, math } = input;
  const payer = config.creator;
  const quote = quoteOf(config);
  const native = quote.mint === WSOL_MINT;
  const blockers: string[] = [];
  if (tx.feePayer?.toBase58() !== payer) blockers.push('The fee would be paid by an account other than yours.');
  const signers = new Set<string>();
  for (const ix of tx.instructions) for (const m of ix.keys) if (m.isSigner) signers.add(m.pubkey.toBase58());
  for (const s of signers) if (s !== payer && s !== nft) blockers.push(`An unexpected account would have to sign: ${s}.`);

  const ixs = tx.instructions;
  // SOL as the other side adds a wrap and a sync step; any other token does not.
  const expectedCount = (native ? 6 : 4) + (config.lockLiquidity ? 1 : 0);
  if (ixs.length !== expectedCount) return [...blockers, 'The transaction is not the expected set of steps.'];

  const key = (ix: Web3.TransactionInstruction, i: number) => ix.keys[i]?.pubkey.toBase58() ?? '';
  const flags = (ix: Web3.TransactionInstruction, i: number) => `${ix.keys[i]?.isSigner ? 'S' : ''}${ix.keys[i]?.isWritable ? 'W' : ''}`;
  const program = (ix: Web3.TransactionInstruction) => ix.programId.toBase58();
  const data = (ix: Web3.TransactionInstruction) => Uint8Array.from(ix.data);
  const wrapped = ataAddress(web3, payer, quote.mint, quote.program);
  const held = ataAddress(web3, payer, config.mint, TOKEN_2022_PROGRAM_ID);

  // 0. Aretia's fee.
  const [fee, ataA, ataB, ...rest] = ixs as [Web3.TransactionInstruction, ...Web3.TransactionInstruction[]];
  const [wrap, sync, init, lock] = (native ? rest : [undefined, undefined, ...rest]) as (Web3.TransactionInstruction | undefined)[];
  const feeData = data(fee);
  if (program(fee) !== SYSTEM_PROGRAM_ID || feeData.length !== 12 || view(feeData).getUint32(0, true) !== 2 || fee.keys.length !== 2)
    blockers.push('The first step is not the Aretia fee.');
  else {
    if (key(fee, 0) !== payer || key(fee, 1) !== POOL_FEE_ADDRESS) blockers.push('The Aretia fee would go to an account other than the one shown.');
    if (view(feeData).getBigUint64(4, true) !== POOL_FEE_LAMPORTS) blockers.push('The Aretia fee is not the amount shown.');
  }

  // 1 and 2. The creator's own token accounts, owned by the creator.
  const ataCheck = (ix: Web3.TransactionInstruction | undefined, ata: string, mint: string, tokenProgram: string, label: string) => {
    if (!ix) return;
    const d = data(ix);
    if (program(ix) !== ATA_PROGRAM_ID || d.length !== 1 || d[0] !== 1 || ix.keys.length !== 6) return blockers.push(`The ${label} account step is not the expected one.`);
    if (key(ix, 0) !== payer || key(ix, 1) !== ata || key(ix, 2) !== payer || key(ix, 3) !== mint || key(ix, 4) !== SYSTEM_PROGRAM_ID || key(ix, 5) !== tokenProgram)
      blockers.push(`The ${label} account would be created for an account other than yours.`);
  };
  ataCheck(ataA, held, config.mint, TOKEN_2022_PROGRAM_ID, 'token');
  ataCheck(ataB, wrapped, quote.mint, quote.program, native ? 'wrapped SOL' : `${quote.symbol}`);

  // 3. With SOL as the other side: one lamport into the creator's own wrapped-SOL account, then a sync. Nothing else is sent for any other token.
  if (native) {
    const wd = wrap ? data(wrap) : new Uint8Array();
    if (!wrap || program(wrap) !== SYSTEM_PROGRAM_ID || wd.length !== 12 || view(wd).getUint32(0, true) !== 2 || wrap.keys.length !== 2)
      blockers.push('The wrapped-SOL step is not the expected one.');
    else if (key(wrap, 0) !== payer || key(wrap, 1) !== wrapped || view(wd).getBigUint64(4, true) !== WRAP_LAMPORTS)
      blockers.push('The wrapped-SOL step would send SOL somewhere other than your own wrapped-SOL account, or a different amount.');
    const sd = sync ? data(sync) : new Uint8Array();
    if (!sync || program(sync) !== TOKEN_PROGRAM_ID || sd.length !== 1 || sd[0] !== 17 || sync.keys.length !== 1 || key(sync, 0) !== wrapped)
      blockers.push('The wrapped-SOL sync step is not the expected one.');
  }

  // 4. The pool.
  if (!init || program(init) !== METEORA_PROGRAM_ID) return [...blockers, 'The pool step is not made by the pool program.'];
  const d = data(init);
  if (init.keys.length !== 21 || d.length !== 107 || !bytesEqual(d.subarray(0, 8), INIT_DISCRIMINATOR)) return [...blockers, 'The pool step is not the expected one.'];
  const want: [number, string, string, string][] = [
    [0, payer, '', 'the pool creator'],
    [1, nft, 'SW', 'the position NFT'],
    [3, payer, 'SW', 'the payer'],
    [4, METEORA_POOL_AUTHORITY, '', 'the pool authority'],
    [5, pool, 'W', 'the pool'],
    [7, config.mint, '', 'the token'],
    [8, quote.mint, '', 'the other side of the pool'],
    [11, held, 'W', 'the source of the tokens'],
    [12, wrapped, 'W', 'the other side source'],
    [13, TOKEN_2022_PROGRAM_ID, '', 'the token program'],
    [14, quote.program, '', 'the other side token program'],
    [15, TOKEN_2022_PROGRAM_ID, '', 'the Token-2022 program'],
    [16, SYSTEM_PROGRAM_ID, '', 'the system program'],
    [17, eventAuthority(web3), '', 'the event authority'],
    [18, METEORA_PROGRAM_ID, '', 'the pool program'],
    [19, tokenBadge(web3, config.mint), '', 'the token badge'],
    [20, tokenBadge(web3, quote.mint), '', 'the other side token badge'],
  ];
  for (const [i, address, flag, label] of want) {
    if (key(init, i) !== address || flags(init, i) !== flag) blockers.push(`The pool step uses an unexpected account for ${label}.`);
  }
  // Position, its NFT token account, the two vaults: derived by the program itself from the accounts above, which it checks.
  for (const i of [2, 6, 9, 10]) if (flags(init, i) !== 'W') blockers.push('The pool step marks an account the wrong way.');

  // Arguments, byte by byte: fee block, price range, liquidity, activation.
  // The fee block is checked against one written by hand from the config (not the builder's own copy), and against the builder's.
  if (!bytesEqual(d.subarray(8, 35), expectedBaseFee(config)) || !bytesEqual(d.subarray(8, 35), math.baseFee))
    blockers.push(config.launchProtection ? 'The trading fee is not the launch-protection schedule shown.' : 'The trading fee is not the one shown.');
  if (view(d).getUint16(35, true) !== 0 || d[37] !== 0 || d[38] !== 0) blockers.push('The pool would use fee options this page does not offer.');
  if (u128(d, 39).toString() !== math.minSqrtPrice.toString()) blockers.push('The starting price is not the one shown.');
  // Independently of the SDK: the price from the config with integer maths (allowing only rounding, one part in 10^12), the
  // tokens the liquidity really takes (never more than shown, and not noticeably fewer), and the pool's address from its seeds.
  const sqrtWant = expectedSqrtPrice(config.price, config.decimals, quote.decimals);
  const sqrtGot = u128(d, 39);
  const diff = sqrtWant === null ? null : sqrtGot > sqrtWant ? sqrtGot - sqrtWant : sqrtWant - sqrtGot;
  if (diff === null || diff > 2n + sqrtWant! / 1_000_000_000_000n) blockers.push('The starting price does not work out to the price you entered.');
  const tokens = impliedTokenAmount(u128(d, 72), sqrtGot, u128(d, 55));
  if (tokens === null || tokens > config.tokenAmountRaw || tokens * 1_000_000n < config.tokenAmountRaw * 999_999n) blockers.push('The liquidity does not match the amount of tokens shown.');
  if (pool !== meteoraPoolAddress(web3, config.mint, quote.mint) || key(init, 5) !== meteoraPoolAddress(web3, config.mint, quote.mint)) blockers.push('The pool address is not the one fixed by the two tokens.');
  if (u128(d, 55).toString() !== math.maxSqrtPrice.toString()) blockers.push('The top of the price range is not the expected one.');
  if (d[71] !== 0) blockers.push('The pool would have an alpha vault.');
  if (u128(d, 72).toString() !== math.liquidity.toString()) blockers.push('The amount going into the pool is not the one shown.');
  if (u128(d, 88).toString() !== math.minSqrtPrice.toString()) blockers.push('The pool would open at a price other than the one shown.');
  if (d[104] !== ACTIVATION_TIMESTAMP) blockers.push('The pool would use an activation type this page does not offer.');
  if (d[105] !== 0) blockers.push('The pool would collect fees in a way this page does not offer.');
  if (d[106] !== 0) blockers.push('The pool would open at a set time instead of at once.');

  // 5. The lock.
  if (config.lockLiquidity) {
    const ld = lock ? data(lock) : new Uint8Array();
    if (!lock || program(lock) !== METEORA_PROGRAM_ID || ld.length !== 24 || lock.keys.length !== 6 || !bytesEqual(ld.subarray(0, 8), LOCK_DISCRIMINATOR))
      blockers.push('The lock step is not the expected one.');
    else {
      if (u128(ld, 8).toString() !== math.liquidity.toString()) blockers.push('The amount being locked is not the amount going in.');
      if (key(lock, 0) !== pool || key(lock, 1) !== key(init, 6) || key(lock, 2) !== key(init, 2) || key(lock, 3) !== payer || flags(lock, 3) !== 'S' || key(lock, 4) !== eventAuthority(web3) || key(lock, 5) !== METEORA_PROGRAM_ID)
        blockers.push('The lock step is about a different pool or position than the one being made.');
    }
  }
  return blockers;
}
