/**
 * Aretia-built Solana swap transactions for Raydium CPMM. Nothing is outsourced: the instruction list, account
 * order and data are assembled here from the pool facts Aretia read, and can be inspected before anything is
 * signed. The transaction is returned unsigned.
 *
 * Native SOL is wrapped into the user's wSOL account for the swap and unwrapped afterwards. A wSOL account that
 * already holds a balance is left alone (never closed), so the swap cannot change what the user already has.
 */
import type * as Web3 from '@solana/web3.js';
import { ataAddress, createAtaIdempotentInstruction, solTransferInstruction, TOKEN_PROGRAM_ID } from '../../scripts/walletTools.js';
import { SwingsError, type TokenRef } from '../core/types.js';
import type { LiquidityPool } from '../engine/types.js';
import { RAYDIUM_CPMM_PROGRAM } from './raydiumCpmm.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface CpmmSwapStep {
  pool: LiquidityPool;
  tokenIn: TokenRef;
  tokenOut: TokenRef;
  amountIn: bigint;
  minOut: bigint;
}

export interface BuildOptions {
  user: string;
  step: CpmmSwapStep;
  /** The user is selling native SOL / receiving native SOL (wrapped for the swap). */
  nativeIn: boolean;
  nativeOut: boolean;
  /** Close the wSOL account afterwards: only when this transaction opens it, or it was empty. */
  closeWsol: boolean;
  recentBlockhash: string;
  computeUnits?: number;
  /** Priority fee in micro-lamports per compute unit. Capped by `MAX_PRIORITY_MICRO_LAMPORTS`. */
  priorityMicroLamports?: number;
}

/** Hard ceiling so a bug cannot overpay: 200k units * 5,000 micro-lamports = 1,000 lamports. */
export const MAX_PRIORITY_MICRO_LAMPORTS = 5_000;

let cachedDiscriminator: Uint8Array | null = null;
/** Anchor instruction tag: the first 8 bytes of sha256("global:swap_base_input"). */
export async function swapBaseInputDiscriminator(): Promise<Uint8Array> {
  if (cachedDiscriminator) return cachedDiscriminator;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('global:swap_base_input'));
  cachedDiscriminator = new Uint8Array(digest).slice(0, 8);
  return cachedDiscriminator;
}

const u64le = (v: bigint): Uint8Array => {
  if (v < 0n || v >= 1n << 64n) throw new SwingsError('invalid', 'Amount out of range for a u64.');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** The swap_base_input instruction exactly as the program's account list defines it. */
export async function cpmmSwapInstruction(web3: typeof Web3, user: string, step: CpmmSwapStep, inAccount: string, outAccount: string): Promise<Web3.TransactionInstruction> {
  const { pool, tokenIn, tokenOut } = step;
  const x = pool.extra;
  if (!x || pool.ref.dex !== 'raydium-cpmm') throw new SwingsError('invalid', 'This pool cannot be swapped by the CPMM builder.');
  const inIs0 = pool.token0.address === tokenIn.address;
  if (!inIs0 && pool.token1.address !== tokenIn.address) throw new SwingsError('invalid', 'The input token is not in this pool.');
  if ((inIs0 ? pool.token1.address : pool.token0.address) !== tokenOut.address) throw new SwingsError('invalid', 'The output token is not the other side of this pool.');
  if (step.amountIn <= 0n) throw new SwingsError('invalid', 'The amount must be above zero.');
  if (step.minOut <= 0n) throw new SwingsError('invalid', 'A swap needs a minimum output above zero.');
  const pk = (a: string): Web3.PublicKey => new web3.PublicKey(a);
  const meta = (a: string, isWritable: boolean, isSigner = false) => ({ pubkey: pk(a), isSigner, isWritable });
  return new web3.TransactionInstruction({
    programId: pk(RAYDIUM_CPMM_PROGRAM),
    keys: [
      meta(user, false, true),
      meta(x.authority!, false),
      meta(x.ammConfig!, false),
      meta(pool.ref.address, true),
      meta(inAccount, true),
      meta(outAccount, true),
      meta(inIs0 ? x.vault0! : x.vault1!, true),
      meta(inIs0 ? x.vault1! : x.vault0!, true),
      meta(inIs0 ? x.program0! : x.program1!, false),
      meta(inIs0 ? x.program1! : x.program0!, false),
      meta(tokenIn.address, false),
      meta(tokenOut.address, false),
      meta(x.observation!, true),
    ],
    data: Buffer.from(concat(await swapBaseInputDiscriminator(), u64le(step.amountIn), u64le(step.minOut))),
  });
}

const syncNative = (web3: typeof Web3, account: string): Web3.TransactionInstruction =>
  new web3.TransactionInstruction({ programId: new web3.PublicKey(TOKEN_PROGRAM_ID), keys: [{ pubkey: new web3.PublicKey(account), isSigner: false, isWritable: true }], data: Buffer.from([17]) });

const closeAccount = (web3: typeof Web3, account: string, destination: string, owner: string): Web3.TransactionInstruction =>
  new web3.TransactionInstruction({
    programId: new web3.PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: new web3.PublicKey(account), isSigner: false, isWritable: true },
      { pubkey: new web3.PublicKey(destination), isSigner: false, isWritable: true },
      { pubkey: new web3.PublicKey(owner), isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]),
  });

export interface BuiltSwap {
  transaction: Web3.VersionedTransaction;
  /** Human-readable list of what the transaction does, in order. */
  steps: string[];
  inAccount: string;
  outAccount: string;
}

export interface GenericBuildOptions {
  user: string;
  tokenIn: TokenRef;
  tokenOut: TokenRef;
  /** Token program of each mint (the classic Token program or Token-2022): it decides the associated account address. */
  programIn: string;
  programOut: string;
  amountIn: bigint;
  nativeIn: boolean;
  nativeOut: boolean;
  /** Close the wSOL account afterwards: only when this transaction opens it, or it was empty. */
  closeWsol: boolean;
  recentBlockhash: string;
  computeUnits?: number;
  priorityMicroLamports?: number;
  /** Plain-language line describing the swap instruction itself. */
  swapLabel: string;
  /** Builds the venue's swap instruction for the user's input and output token accounts. */
  swapInstruction: (inAccount: string, outAccount: string) => Promise<Web3.TransactionInstruction>;
}

/**
 * The venue-independent part of a Solana swap: compute budget, the user's token accounts, wrapping and unwrapping
 * SOL, then the venue's own swap instruction. Venues supply only `swapInstruction`.
 */
export async function buildSwapTransaction(web3: typeof Web3, o: GenericBuildOptions): Promise<BuiltSwap> {
  const inAccount = ataAddress(web3, o.user, o.tokenIn.address, o.programIn);
  const outAccount = ataAddress(web3, o.user, o.tokenOut.address, o.programOut);
  const priority = Math.min(o.priorityMicroLamports ?? 1_000, MAX_PRIORITY_MICRO_LAMPORTS);
  const ixs: Web3.TransactionInstruction[] = [
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: o.computeUnits ?? 200_000 }),
    web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
  ];
  const steps: string[] = [`Set compute limit and a capped priority fee (${priority} micro-lamports per unit).`];

  if (o.nativeIn) {
    ixs.push(createAtaIdempotentInstruction(web3, o.user, inAccount, o.user, o.tokenIn.address, o.programIn));
    ixs.push(solTransferInstruction(web3, o.user, inAccount, o.amountIn));
    ixs.push(syncNative(web3, inAccount));
    steps.push(`Wrap ${o.amountIn} lamports of SOL into your wSOL account.`);
  }
  ixs.push(createAtaIdempotentInstruction(web3, o.user, outAccount, o.user, o.tokenOut.address, o.programOut));
  steps.push(`Make sure your ${o.tokenOut.address.slice(0, 4)}… token account exists (you pay its rent only if it is new).`);
  ixs.push(await o.swapInstruction(inAccount, outAccount));
  steps.push(o.swapLabel);
  if (o.nativeIn && o.closeWsol) {
    ixs.push(closeAccount(web3, inAccount, o.user, o.user));
    steps.push('Close the temporary wSOL account and return its SOL.');
  }
  if (o.nativeOut && o.closeWsol) {
    ixs.push(closeAccount(web3, outAccount, o.user, o.user));
    steps.push('Unwrap the received wSOL back to SOL.');
  }
  const message = new web3.TransactionMessage({ payerKey: new web3.PublicKey(o.user), recentBlockhash: o.recentBlockhash, instructions: ixs }).compileToV0Message();
  return { transaction: new web3.VersionedTransaction(message), steps, inAccount, outAccount };
}

/** Raydium CPMM: a swap through one constant-product pool. */
export async function buildCpmmSwapTransaction(web3: typeof Web3, o: BuildOptions): Promise<BuiltSwap> {
  const { step } = o;
  const x = step.pool.extra;
  if (!x) throw new SwingsError('invalid', 'The pool has no venue data.');
  const programOf = (mint: string): string => (mint === step.pool.token0.address ? x.program0! : x.program1!);
  return buildSwapTransaction(web3, {
    user: o.user,
    tokenIn: step.tokenIn,
    tokenOut: step.tokenOut,
    programIn: programOf(step.tokenIn.address),
    programOut: programOf(step.tokenOut.address),
    amountIn: step.amountIn,
    nativeIn: o.nativeIn,
    nativeOut: o.nativeOut,
    closeWsol: o.closeWsol,
    recentBlockhash: o.recentBlockhash,
    computeUnits: o.computeUnits,
    priorityMicroLamports: o.priorityMicroLamports,
    swapLabel: `Raydium CPMM pool ${step.pool.ref.address.slice(0, 8)}…: swap exactly ${step.amountIn} (raw) for at least ${step.minOut} (raw), or the whole transaction fails.`,
    swapInstruction: (inAccount, outAccount) => cpmmSwapInstruction(web3, o.user, step, inAccount, outAccount),
  });
}
