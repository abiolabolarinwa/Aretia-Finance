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
import { tipInstruction } from './jito.js';
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

/** One swap inside a route. Steps run in order, in one transaction: a multi-hop route chains them, a split runs several side by side. */
export interface RouteStep {
  tokenIn: TokenRef;
  tokenOut: TokenRef;
  /** Token program of each mint (the classic Token program or Token-2022): it decides the associated account address. */
  programIn: string;
  programOut: string;
  amountIn: bigint;
  /** Plain-language line describing this swap instruction. */
  label: string;
  /** Deliver the output to this owner's associated account instead of the user's (the user pays its rent). Used by the buyback only. */
  outOwner?: string;
  /** Builds the venue's swap instruction for the user's accounts. */
  swapInstruction: (inAccount: string, outAccount: string) => Promise<Web3.TransactionInstruction | Web3.TransactionInstruction[]>;
}

export interface RouteBuildOptions {
  user: string;
  steps: RouteStep[];
  /** The user sells native SOL / receives native SOL (wrapped for the swap). */
  nativeIn: boolean;
  nativeOut: boolean;
  /** Close the wSOL account afterwards: only when this transaction opens it, or it was empty. */
  closeWsol: boolean;
  recentBlockhash: string;
  computeUnits?: number;
  priorityMicroLamports?: number;
  /** Protected submission: a tip to one of Jito's tip accounts, added last so it is paid only if the swap ran. */
  tip?: { account: string; lamports: number };
  /** Extra instructions that run after the token accounts exist and before the swaps (for example the ACT buyback transfer). */
  prelude?: (accounts: Record<string, string>) => { ixs: Web3.TransactionInstruction[]; steps: string[] };
}

export interface BuiltRoute extends BuiltSwap {
  /** The user's token account for each mint the route touches. */
  accounts: Record<string, string>;
}

/**
 * The venue-independent part of a Solana swap: compute budget, every token account the route touches, wrapping and
 * unwrapping SOL, then each venue's own swap instruction in order. Venues supply only their `swapInstruction`.
 */
export async function buildRouteTransaction(web3: typeof Web3, o: RouteBuildOptions): Promise<BuiltRoute> {
  if (o.steps.length === 0 || o.steps.length > 4) throw new SwingsError('invalid', 'A route needs one to four swap steps.');
  const priority = Math.min(o.priorityMicroLamports ?? 1_000, MAX_PRIORITY_MICRO_LAMPORTS);
  // The program of every mint, from the steps that mention it.
  const programOf = new Map<string, string>();
  for (const st of o.steps) {
    programOf.set(st.tokenIn.address, st.programIn);
    if (!st.outOwner) programOf.set(st.tokenOut.address, st.programOut);
  }
  const accounts: Record<string, string> = {};
  for (const [mint, program] of programOf) accounts[mint] = ataAddress(web3, o.user, mint, program);
  const routeIn = o.steps[0]!.tokenIn.address;
  const routeOut = o.steps[o.steps.length - 1]!.tokenOut.address;
  if (o.steps[o.steps.length - 1]!.outOwner) throw new SwingsError('invalid', 'The last step of a route must pay the user.');
  const recipients = new Map<string, string>();
  for (const st of o.steps) if (st.outOwner) recipients.set(st.outOwner + ':' + st.tokenOut.address, ataAddress(web3, st.outOwner, st.tokenOut.address, st.programOut));

  const ixs: Web3.TransactionInstruction[] = [
    web3.ComputeBudgetProgram.setComputeUnitLimit({ units: Math.min(o.computeUnits ?? 200_000 * o.steps.length, 1_400_000) }),
    web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priority }),
  ];
  const steps: string[] = [`Set compute limit and a capped priority fee (${priority} micro-lamports per unit).`];

  if (o.nativeIn) {
    const total = o.steps.filter((s) => s.tokenIn.address === routeIn).reduce((n, s) => n + s.amountIn, 0n);
    ixs.push(createAtaIdempotentInstruction(web3, o.user, accounts[routeIn]!, o.user, routeIn, programOf.get(routeIn)!));
    ixs.push(solTransferInstruction(web3, o.user, accounts[routeIn]!, total));
    ixs.push(syncNative(web3, accounts[routeIn]!));
    steps.push(`Wrap ${total} lamports of SOL into your wSOL account.`);
  }
  // Every other mint the route touches needs an account; the user's own input account must already exist.
  for (const [mint, program] of programOf) {
    if (mint === routeIn) continue;
    ixs.push(createAtaIdempotentInstruction(web3, o.user, accounts[mint]!, o.user, mint, program));
    steps.push(`Make sure your ${mint.slice(0, 4)}… token account exists (you pay its rent only if it is new).`);
  }
  if (o.prelude) {
    const extra = o.prelude(accounts);
    ixs.push(...extra.ixs);
    steps.push(...extra.steps);
  }
  for (const [key, ata] of recipients) {
    const st = o.steps.find((s) => s.outOwner && s.outOwner + ':' + s.tokenOut.address === key)!;
    ixs.push(createAtaIdempotentInstruction(web3, o.user, ata, st.outOwner!, st.tokenOut.address, st.programOut));
    steps.push(`Make sure the ${st.tokenOut.address.slice(0, 4)}… account of ${st.outOwner!.slice(0, 4)}… exists (you pay its rent only if it is new).`);
  }
  for (const st of o.steps) {
    const dest = st.outOwner ? recipients.get(st.outOwner + ':' + st.tokenOut.address)! : accounts[st.tokenOut.address]!;
    const made = await st.swapInstruction(accounts[st.tokenIn.address]!, dest);
    ixs.push(...(Array.isArray(made) ? made : [made]));
    steps.push(st.label);
  }
  // wSOL accounts this transaction opened (as input, output or a stop on the way) are closed again, returning their SOL.
  if (o.closeWsol && programOf.has(WSOL_MINT) && (o.nativeIn || o.nativeOut || (routeIn !== WSOL_MINT && routeOut !== WSOL_MINT))) {
    ixs.push(closeAccount(web3, accounts[WSOL_MINT]!, o.user, o.user));
    steps.push(o.nativeOut ? 'Unwrap the received wSOL back to SOL.' : 'Close the temporary wSOL account and return its SOL.');
  }
  if (o.tip) {
    ixs.push(tipInstruction(web3, o.user, o.tip.lamports, o.tip.account));
    steps.push(`Pay a ${o.tip.lamports} lamport tip to Jito for protected (private) sending. It is paid only if the swap above succeeds.`);
  }
  const message = new web3.TransactionMessage({ payerKey: new web3.PublicKey(o.user), recentBlockhash: o.recentBlockhash, instructions: ixs }).compileToV0Message();
  return { transaction: new web3.VersionedTransaction(message), steps, inAccount: accounts[routeIn]!, outAccount: accounts[routeOut]!, accounts };
}

export interface GenericBuildOptions {
  user: string;
  tokenIn: TokenRef;
  tokenOut: TokenRef;
  programIn: string;
  programOut: string;
  amountIn: bigint;
  nativeIn: boolean;
  nativeOut: boolean;
  closeWsol: boolean;
  recentBlockhash: string;
  computeUnits?: number;
  priorityMicroLamports?: number;
  swapLabel: string;
  swapInstruction: (inAccount: string, outAccount: string) => Promise<Web3.TransactionInstruction>;
}

/** A route of exactly one swap. Kept for the common single-pool case. */
export async function buildSwapTransaction(web3: typeof Web3, o: GenericBuildOptions): Promise<BuiltSwap> {
  const built = await buildRouteTransaction(web3, {
    user: o.user,
    steps: [{ tokenIn: o.tokenIn, tokenOut: o.tokenOut, programIn: o.programIn, programOut: o.programOut, amountIn: o.amountIn, label: o.swapLabel, swapInstruction: o.swapInstruction }],
    nativeIn: o.nativeIn,
    nativeOut: o.nativeOut,
    closeWsol: o.closeWsol,
    recentBlockhash: o.recentBlockhash,
    computeUnits: o.computeUnits,
    priorityMicroLamports: o.priorityMicroLamports,
  });
  return built;
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
