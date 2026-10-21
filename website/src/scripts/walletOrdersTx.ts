/**
 * Limit orders on the web wallet: the transactions, and a check of them before anyone signs.
 *
 * Built with @solana/web3.js only; the order program's instructions are encoded here by hand and checked byte for byte against
 * the instructions the program's own Rust tests build (see walletOrdersTx.test.ts and __fixtures__/orders). Nothing here signs.
 */
import type * as Web3 from '@solana/web3.js';
import { ATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ataAddress, createAtaIdempotentInstruction, solTransferInstruction } from './walletTools';

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const WRAPPED_SOL_MINT = 'So11111111111111111111111111111111111111112';

/** sha256("global:<name>")[..8], the order program's Anchor instruction discriminators. */
const CREATE_ORDER = Uint8Array.from([141, 54, 37, 207, 237, 210, 250, 215]);
const CANCEL_ORDER = Uint8Array.from([95, 129, 237, 240, 8, 49, 223, 132]);
/** SPL Token instruction numbers used here. */
const SYNC_NATIVE = 17;
const CLOSE_ACCOUNT = 9;

const utf8 = new TextEncoder();

function u64le(value: bigint): Uint8Array {
  if (value < 0n || value >= 2n ** 64n) throw new RangeError('Amount does not fit in 64 bits.');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const keyOf = (web3: typeof Web3, address: string, isSigner: boolean, isWritable: boolean): Web3.AccountMeta => ({
  pubkey: new web3.PublicKey(address),
  isSigner,
  isWritable,
});
const instruction = (web3: typeof Web3, programId: string, keys: Web3.AccountMeta[], data: Uint8Array): Web3.TransactionInstruction =>
  new web3.TransactionInstruction({
    programId: new web3.PublicKey(programId),
    keys,
    data: data as unknown as Buffer,
  });

// ---------------------------------------------------------------- addresses

function pda(web3: typeof Web3, program: string, seeds: Uint8Array[]): string {
  return web3.PublicKey.findProgramAddressSync(seeds, new web3.PublicKey(program))[0].toBase58();
}
export const ordersConfigAddress = (web3: typeof Web3, program: string): string => pda(web3, program, [utf8.encode('config')]);
export const ordersAssetAddress = (web3: typeof Web3, program: string, mint: string): string => pda(web3, program, [utf8.encode('asset'), new web3.PublicKey(mint).toBytes()]);
export const orderAddress = (web3: typeof Web3, program: string, owner: string, nonce: bigint): string => pda(web3, program, [utf8.encode('order'), new web3.PublicKey(owner).toBytes(), u64le(nonce)]);
/** The web wallet's curve account for a token: it proves to the order program that the token is an Aretia Launch token. */
export const curveAddressOf = (web3: typeof Web3, curveProgram: string, mint: string): string => pda(web3, curveProgram, [utf8.encode('curve'), new web3.PublicKey(mint).toBytes()]);

// ---------------------------------------------------------------- instructions

export interface OrderTxInput {
  programId: string;
  owner: string;
  launchMint: string;
  /** Launch tokens are Token-2022. */
  launchTokenProgram: string;
  curve: string;
  /** The payment asset. Wrapped SOL, which is what this page always uses; the golden tests pass another to match the Rust file. */
  quoteMint?: string;
}

export interface CreateArgs extends OrderTxInput {
  side: 'buy' | 'sell';
  nonce: bigint;
  amountIn: bigint;
  minOut: bigint;
}

/** The order program's `create_order`. The payment asset is wrapped SOL (a classic-token mint). */
export function createOrderInstruction(web3: typeof Web3, a: CreateArgs): Web3.TransactionInstruction {
  const q = a.quoteMint ?? WRAPPED_SOL_MINT;
  const order = orderAddress(web3, a.programId, a.owner, a.nonce);
  const ata = (owner: string, mint: string, tp: string) => ataAddress(web3, owner, mint, tp);
  return instruction(
    web3,
    a.programId,
    [
      keyOf(web3, a.owner, true, true),
      keyOf(web3, ordersConfigAddress(web3, a.programId), false, false),
      keyOf(web3, ordersAssetAddress(web3, a.programId, q), false, false),
      keyOf(web3, order, false, true),
      keyOf(web3, a.launchMint, false, false),
      keyOf(web3, q, false, false),
      keyOf(web3, a.curve, false, false),
      keyOf(web3, ata(a.owner, a.launchMint, a.launchTokenProgram), false, true),
      keyOf(web3, ata(a.owner, q, TOKEN_PROGRAM_ID), false, true),
      keyOf(web3, ata(order, a.launchMint, a.launchTokenProgram), false, true),
      keyOf(web3, ata(order, q, TOKEN_PROGRAM_ID), false, true),
      keyOf(web3, a.launchTokenProgram, false, false),
      keyOf(web3, TOKEN_PROGRAM_ID, false, false),
      keyOf(web3, ATA_PROGRAM_ID, false, false),
      keyOf(web3, SYSTEM_PROGRAM_ID, false, false),
    ],
    concat(CREATE_ORDER, Uint8Array.of(a.side === 'buy' ? 0 : 1), u64le(a.nonce), u64le(a.amountIn), u64le(a.minOut)),
  );
}

export interface CancelArgs extends OrderTxInput {
  order: string;
  /** The fee recipient stored in the program's config. */
  feeRecipient: string;
}

/** The order program's `cancel_order`: refunds what is unfilled, less the cancel fee, and closes the order. */
export function cancelOrderInstruction(web3: typeof Web3, a: CancelArgs): Web3.TransactionInstruction {
  const q = a.quoteMint ?? WRAPPED_SOL_MINT;
  const ata = (owner: string, mint: string, tp: string) => ataAddress(web3, owner, mint, tp);
  return instruction(
    web3,
    a.programId,
    [
      keyOf(web3, a.owner, true, true),
      keyOf(web3, ordersConfigAddress(web3, a.programId), false, false),
      keyOf(web3, a.order, false, true),
      keyOf(web3, a.launchMint, false, false),
      keyOf(web3, q, false, false),
      keyOf(web3, ata(a.order, a.launchMint, a.launchTokenProgram), false, true),
      keyOf(web3, ata(a.order, q, TOKEN_PROGRAM_ID), false, true),
      keyOf(web3, ata(a.owner, a.launchMint, a.launchTokenProgram), false, true),
      keyOf(web3, ata(a.owner, q, TOKEN_PROGRAM_ID), false, true),
      keyOf(web3, ata(a.feeRecipient, q, TOKEN_PROGRAM_ID), false, true),
      keyOf(web3, ata(a.feeRecipient, a.launchMint, a.launchTokenProgram), false, true),
      keyOf(web3, a.launchTokenProgram, false, false),
      keyOf(web3, TOKEN_PROGRAM_ID, false, false),
    ],
    CANCEL_ORDER,
  );
}

/**
 * Puts `lamports` of SOL into the owner's wrapped-SOL account (creating it if needed): the escrow of a buy is wrapped SOL.
 * Only the shortfall is wrapped, so SOL already wrapped is used first.
 */
export function wrapSolInstructions(web3: typeof Web3, owner: string, lamports: bigint): Web3.TransactionInstruction[] {
  const ata = ataAddress(web3, owner, WRAPPED_SOL_MINT, TOKEN_PROGRAM_ID);
  const out = [createAtaIdempotentInstruction(web3, owner, ata, owner, WRAPPED_SOL_MINT, TOKEN_PROGRAM_ID)];
  if (lamports > 0n) {
    out.push(solTransferInstruction(web3, owner, ata, lamports));
    out.push(instruction(web3, TOKEN_PROGRAM_ID, [keyOf(web3, ata, false, true)], Uint8Array.of(SYNC_NATIVE)));
  }
  return out;
}

/** Closes the owner's wrapped-SOL account: everything in it, and its rent, comes back as plain SOL. */
export function unwrapSolInstruction(web3: typeof Web3, owner: string): Web3.TransactionInstruction {
  const ata = ataAddress(web3, owner, WRAPPED_SOL_MINT, TOKEN_PROGRAM_ID);
  return instruction(web3, TOKEN_PROGRAM_ID, [keyOf(web3, ata, false, true), keyOf(web3, owner, false, true), keyOf(web3, owner, true, false)], Uint8Array.of(CLOSE_ACCOUNT));
}

// ---------------------------------------------------------------- reading a transaction back

export interface Expected {
  programId: string;
  owner: string;
  /** Called with the instruction list the page is about to ask the wallet to sign. */
  instructions: Web3.TransactionInstruction[];
}

/**
 * Checks, before signing, that a transaction contains only what this page meant to build: only the programs listed, the
 * owner as the one signer, and (for the order program) exactly the instruction bytes and accounts expected. Returns the problems.
 */
export function inspectOrderTransaction(web3: typeof Web3, tx: Web3.Transaction, expected: Expected): string[] {
  const problems: string[] = [];
  const allowed = new Set([expected.programId, SYSTEM_PROGRAM_ID, TOKEN_PROGRAM_ID, ATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);
  if (tx.feePayer?.toBase58() !== expected.owner) problems.push('The transaction is not paid for by your wallet.');
  if (tx.instructions.length !== expected.instructions.length) problems.push('The transaction has a different number of steps than expected.');
  const n = Math.min(tx.instructions.length, expected.instructions.length);
  for (let i = 0; i < n; i++) {
    const got = tx.instructions[i]!;
    const want = expected.instructions[i]!;
    if (!allowed.has(got.programId.toBase58())) problems.push(`Step ${i + 1} calls a program this page did not mean to use.`);
    const same =
      got.programId.equals(want.programId) &&
      Buffer.from(got.data).equals(Buffer.from(want.data)) &&
      got.keys.length === want.keys.length &&
      got.keys.every((k, j) => k.pubkey.equals(want.keys[j]!.pubkey) && k.isSigner === want.keys[j]!.isSigner && k.isWritable === want.keys[j]!.isWritable);
    if (!same) problems.push(`Step ${i + 1} is not what this page built.`);
    for (const k of got.keys) {
      if (k.isSigner && k.pubkey.toBase58() !== expected.owner) problems.push(`Step ${i + 1} asks for a signature from an account that is not yours.`);
    }
  }
  return [...new Set(problems)];
}
