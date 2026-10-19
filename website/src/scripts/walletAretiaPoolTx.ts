/**
 * Aretia Pool on the web wallet: the transactions, and a check of each before anyone signs.
 *
 * Unlike the Meteora pool (walletPoolTx.ts) there is no SDK to lean on: the program is Aretia's own and small, so each instruction is
 * written here by hand from the layout in program/aretia-pool, and the tests replay the same bytes through the compiled program.
 * What matters more is the check. The inspector reads the transaction back as raw bytes and does not use the builder: it derives
 * every address itself, builds the exact list of steps it expects, and refuses anything else: another program, an extra or missing
 * step, a different account, flag, amount or recipient, an extra signer, a different fee payer.
 *
 * The pool's SOL side is wrapped SOL (a token), so a transaction that moves SOL wraps it first and unwraps what is left afterwards,
 * the same way any wrapped-SOL swap does. Every step in that sequence is on the inspector's list, byte for byte.
 */
import type * as Web3 from '@solana/web3.js';
import { ATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ataAddress, createAtaIdempotentInstruction } from './walletTools.js';
import { SYSTEM_PROGRAM_ID } from './walletLaunchTx.js';
import { WSOL_MINT } from './walletPoolCore.js';
import { ARETIA_POOL_FEE_ADDRESS, type CreateParams } from './walletAretiaPoolCore.js';

/** Anchor instruction tags: the first 8 bytes of sha256("global:<name>"). The tests recompute them. */
export const DISC = {
  createPool: Uint8Array.from([233, 146, 209, 142, 207, 104, 64, 188]),
  swap: Uint8Array.from([248, 198, 158, 145, 225, 117, 135, 200]),
  addLiquidity: Uint8Array.from([181, 157, 89, 67, 143, 182, 52, 72]),
  removeLiquidity: Uint8Array.from([80, 85, 209, 72, 24, 206, 177, 108]),
  claimFees: Uint8Array.from([82, 251, 233, 156, 12, 52, 184, 202]),
  lockLiquidity: Uint8Array.from([179, 201, 236, 158, 212, 98, 70, 182]),
  transferPosition: Uint8Array.from([139, 130, 102, 147, 135, 77, 113, 222]),
  setRecipient: Uint8Array.from([133, 1, 115, 69, 206, 190, 17, 18]),
} as const;

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------- addresses

export function poolAddress(web3: typeof Web3, program: string, mint: string): string {
  return web3.PublicKey.findProgramAddressSync([Buffer.from('pool'), new web3.PublicKey(mint).toBytes()], new web3.PublicKey(program))[0].toBase58();
}
/** The pool's SOL vault: its associated wrapped-SOL account. */
export function solVaultAddress(web3: typeof Web3, _program: string, pool: string): string {
  return ataAddress(web3, pool, WSOL_MINT, TOKEN_PROGRAM_ID);
}
/** A position's address comes from its id, which is the owner's address unless the position was opened under a key that signed for itself. */
export function positionAddress(web3: typeof Web3, program: string, pool: string, id: string): string {
  return web3.PublicKey.findProgramAddressSync([Buffer.from('position'), new web3.PublicKey(pool).toBytes(), new web3.PublicKey(id).toBytes()], new web3.PublicKey(program))[0].toBase58();
}
/** Anyone's wrapped-SOL associated account. */
export function wsolAccount(web3: typeof Web3, owner: string): string {
  return ataAddress(web3, owner, WSOL_MINT, TOKEN_PROGRAM_ID);
}

// ---------------------------------------------------------------- building

function data(tag: Uint8Array, parts: ({ u64: bigint } | { u32: number } | { u16: number } | { bool: boolean } | { key: Uint8Array })[]): Buffer {
  const size = parts.reduce((n, p) => n + ('u64' in p ? 8 : 'u32' in p ? 4 : 'u16' in p ? 2 : 'key' in p ? 32 : 1), 8);
  const out = Buffer.alloc(size);
  out.set(tag, 0);
  const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let at = 8;
  for (const p of parts) {
    if ('u64' in p) {
      v.setBigUint64(at, p.u64, true);
      at += 8;
    } else if ('u32' in p) {
      v.setUint32(at, p.u32, true);
      at += 4;
    } else if ('u16' in p) {
      v.setUint16(at, p.u16, true);
      at += 2;
    } else if ('key' in p) {
      out.set(p.key, at);
      at += 32;
    } else {
      out[at++] = p.bool ? 1 : 0;
    }
  }
  return out;
}

const key = (web3: typeof Web3, address: string, isSigner: boolean, isWritable: boolean): Web3.AccountMeta => ({ pubkey: new web3.PublicKey(address), isSigner, isWritable });

/** Creates `owner`'s associated account for `mint` if it is missing (idempotent), paid by `payer`. */
function ataIx(web3: typeof Web3, payer: string, owner: string, mint: string, tokenProgram: string): Web3.TransactionInstruction {
  return createAtaIdempotentInstruction(web3, payer, ataAddress(web3, owner, mint, tokenProgram), owner, mint, tokenProgram);
}

/** Wrap SOL: make the wallet's wrapped-SOL account if needed, put `lamports` into it, and sync it. */
function wrapIxs(web3: typeof Web3, owner: string, lamports: bigint): Web3.TransactionInstruction[] {
  const acc = wsolAccount(web3, owner);
  const t = Buffer.alloc(12);
  t.writeUInt32LE(2, 0);
  t.writeBigUInt64LE(lamports, 4);
  return [
    ataIx(web3, owner, owner, WSOL_MINT, TOKEN_PROGRAM_ID),
    new web3.TransactionInstruction({ programId: new web3.PublicKey(SYSTEM_PROGRAM_ID), keys: [key(web3, owner, true, true), key(web3, acc, false, true)], data: t }),
    new web3.TransactionInstruction({ programId: new web3.PublicKey(TOKEN_PROGRAM_ID), keys: [key(web3, acc, false, true)], data: Buffer.from([17]) }),
  ];
}

/** Unwrap: close the wallet's wrapped-SOL account, sending everything in it (and its rent) back to the wallet as SOL. */
function closeWsolIx(web3: typeof Web3, owner: string): Web3.TransactionInstruction {
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(TOKEN_PROGRAM_ID),
    keys: [key(web3, wsolAccount(web3, owner), false, true), key(web3, owner, false, true), key(web3, owner, true, false)],
    data: Buffer.from([9]),
  });
}

export interface BuiltCreate {
  /** The steps in order: Aretia's own wrapped-SOL account if missing, the SOL the creator brings (if any), the pool, and the unwrap. */
  instructions: Web3.TransactionInstruction[];
  pool: string;
  position: string;
  positionId: string;
  vault: string;
  solVault: string;
}

/** `owner` is who will own the position: the creator, on the Launch page. */
export function buildCreatePool(web3: typeof Web3, program: string, p: CreateParams, owner: string = p.creator, positionId: string = owner): BuiltCreate {
  const pool = poolAddress(web3, program, p.mint);
  const solVault = solVaultAddress(web3, program, pool);
  const vault = ataAddress(web3, pool, p.mint, TOKEN_2022_PROGRAM_ID);
  const position = positionAddress(web3, program, pool, positionId);
  const ix = new web3.TransactionInstruction({
    programId: new web3.PublicKey(program),
    keys: [
      key(web3, p.creator, true, true),
      key(web3, owner, false, false),
      key(web3, p.mint, false, false),
      key(web3, ataAddress(web3, p.creator, p.mint, TOKEN_2022_PROGRAM_ID), false, true),
      key(web3, pool, false, true),
      key(web3, solVault, false, true),
      key(web3, vault, false, true),
      key(web3, position, false, true),
      key(web3, ARETIA_POOL_FEE_ADDRESS, false, true),
      key(web3, TOKEN_2022_PROGRAM_ID, false, false),
      key(web3, ATA_PROGRAM_ID, false, false),
      key(web3, SYSTEM_PROGRAM_ID, false, false),
      key(web3, positionId, positionId !== owner, false),
      key(web3, WSOL_MINT, false, false),
      key(web3, wsolAccount(web3, p.creator), false, true),
      key(web3, TOKEN_PROGRAM_ID, false, false),
    ],
    data: data(DISC.createPool, [{ u64: p.x0 }, { u64: p.y0 }, { u64: p.l0 }, { u16: p.feeBps }, { bool: p.lock }, { u16: p.sniperBps }, { u32: p.decaySecs }, { u64: p.vx0 }]),
  });
  const instructions = [
    // Aretia's wrapped-SOL account: every fee payment lands there, so it has to exist before the first swap. Idempotent, paid by the creator.
    ataIx(web3, p.creator, ARETIA_POOL_FEE_ADDRESS, WSOL_MINT, TOKEN_PROGRAM_ID),
    ...(p.y0 > 0n ? wrapIxs(web3, p.creator, p.y0) : []),
    ix,
    ...(p.y0 > 0n ? [closeWsolIx(web3, p.creator)] : []),
  ];
  return { instructions, pool, position, positionId, vault, solVault };
}

export interface SwapParams {
  trader: string;
  mint: string;
  isBuy: boolean;
  amountIn: bigint;
  minOut: bigint;
}

/** The pool's swap instruction alone (what a router builds around). */
export function buildSwap(web3: typeof Web3, program: string, s: SwapParams): Web3.TransactionInstruction {
  const pool = poolAddress(web3, program, s.mint);
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(program),
    keys: [
      key(web3, s.trader, true, true),
      key(web3, pool, false, true),
      key(web3, solVaultAddress(web3, program, pool), false, true),
      key(web3, s.mint, false, false),
      key(web3, ataAddress(web3, pool, s.mint, TOKEN_2022_PROGRAM_ID), false, true),
      key(web3, ataAddress(web3, s.trader, s.mint, TOKEN_2022_PROGRAM_ID), false, true),
      key(web3, wsolAccount(web3, s.trader), false, true),
      key(web3, wsolAccount(web3, ARETIA_POOL_FEE_ADDRESS), false, true),
      key(web3, TOKEN_2022_PROGRAM_ID, false, false),
      key(web3, TOKEN_PROGRAM_ID, false, false),
    ],
    data: data(DISC.swap, [{ bool: s.isBuy }, { u64: s.amountIn }, { u64: s.minOut }]),
  });
}

/**
 * A whole swap for a wallet: a buy wraps `amountIn` of the wallet's SOL first (and makes the wallet's token account if it has none),
 * a sell makes sure the wrapped-SOL account exists; both unwrap everything afterwards, so the wallet ends with plain SOL.
 */
export function buildSwapSteps(web3: typeof Web3, program: string, s: SwapParams): Web3.TransactionInstruction[] {
  return [
    ...(s.isBuy ? [ataIx(web3, s.trader, s.trader, s.mint, TOKEN_2022_PROGRAM_ID), ...wrapIxs(web3, s.trader, s.amountIn)] : [ataIx(web3, s.trader, s.trader, WSOL_MINT, TOKEN_PROGRAM_ID)]),
    buildSwap(web3, program, s),
    closeWsolIx(web3, s.trader),
  ];
}

export interface LiquidityParams {
  owner: string;
  mint: string;
  /** The position's id. The owner's own address unless the position was opened under another key or has been transferred. */
  positionId?: string;
  /** Liquidity to add or remove. */
  dl: bigint;
  /** Add: the most tokens and SOL the owner will pay. Remove: the least tokens and SOL the owner will accept. */
  tokens: bigint;
  sol: bigint;
}

function liquidityKeys(web3: typeof Web3, program: string, owner: string, mint: string, id: string, withId: boolean): Web3.AccountMeta[] {
  const pool = poolAddress(web3, program, mint);
  const keys = [
    key(web3, owner, true, true),
    key(web3, pool, false, true),
    key(web3, solVaultAddress(web3, program, pool), false, true),
    key(web3, mint, false, false),
    key(web3, ataAddress(web3, pool, mint, TOKEN_2022_PROGRAM_ID), false, true),
    key(web3, ataAddress(web3, owner, mint, TOKEN_2022_PROGRAM_ID), false, true),
    key(web3, positionAddress(web3, program, pool, id), false, true),
    key(web3, TOKEN_2022_PROGRAM_ID, false, false),
    key(web3, SYSTEM_PROGRAM_ID, false, false),
  ];
  // Adding takes the id as its tenth account (removing finds the position from its own stored id); both end with the wrapped-SOL pair.
  if (withId) keys.push(key(web3, id, id !== owner, false));
  keys.push(key(web3, wsolAccount(web3, owner), false, true), key(web3, TOKEN_PROGRAM_ID, false, false));
  return keys;
}

export function buildAddLiquidity(web3: typeof Web3, program: string, l: LiquidityParams): Web3.TransactionInstruction {
  return new web3.TransactionInstruction({ programId: new web3.PublicKey(program), keys: liquidityKeys(web3, program, l.owner, l.mint, l.positionId ?? l.owner, true), data: data(DISC.addLiquidity, [{ u64: l.dl }, { u64: l.tokens }, { u64: l.sol }]) });
}

export function buildRemoveLiquidity(web3: typeof Web3, program: string, l: LiquidityParams): Web3.TransactionInstruction {
  return new web3.TransactionInstruction({ programId: new web3.PublicKey(program), keys: liquidityKeys(web3, program, l.owner, l.mint, l.positionId ?? l.owner, false), data: data(DISC.removeLiquidity, [{ u64: l.dl }, { u64: l.tokens }, { u64: l.sol }]) });
}

/** Adding: the wallet's token account if missing, the most SOL it will pay wrapped, the deposit, and the unwrap of what was not used. */
export function buildAddSteps(web3: typeof Web3, program: string, l: LiquidityParams): Web3.TransactionInstruction[] {
  return [ataIx(web3, l.owner, l.owner, l.mint, TOKEN_2022_PROGRAM_ID), ...wrapIxs(web3, l.owner, l.sol), buildAddLiquidity(web3, program, l), closeWsolIx(web3, l.owner)];
}

/** Removing: the wallet's token and wrapped-SOL accounts if missing, the withdrawal, and the unwrap. */
export function buildRemoveSteps(web3: typeof Web3, program: string, l: LiquidityParams): Web3.TransactionInstruction[] {
  return [ataIx(web3, l.owner, l.owner, l.mint, TOKEN_2022_PROGRAM_ID), ataIx(web3, l.owner, l.owner, WSOL_MINT, TOKEN_PROGRAM_ID), buildRemoveLiquidity(web3, program, l), closeWsolIx(web3, l.owner)];
}

/** `recipient` is the wallet the position names to receive its fees (the owner unless changed). Paid in wrapped SOL to the recipient's account. */
export function buildClaim(web3: typeof Web3, program: string, owner: string, mint: string, recipient: string = owner, positionId: string = owner): Web3.TransactionInstruction {
  const pool = poolAddress(web3, program, mint);
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(program),
    keys: [
      key(web3, owner, true, true),
      key(web3, pool, false, true),
      key(web3, solVaultAddress(web3, program, pool), false, true),
      key(web3, positionAddress(web3, program, pool, positionId), false, true),
      key(web3, wsolAccount(web3, recipient), false, true),
      key(web3, TOKEN_PROGRAM_ID, false, false),
    ],
    data: data(DISC.claimFees, []),
  });
}

/** Claiming: the recipient's wrapped-SOL account if missing, the claim, and, when the recipient is the owner, the unwrap. */
export function buildClaimSteps(web3: typeof Web3, program: string, owner: string, mint: string, recipient: string = owner, positionId: string = owner): Web3.TransactionInstruction[] {
  return [ataIx(web3, owner, recipient, WSOL_MINT, TOKEN_PROGRAM_ID), buildClaim(web3, program, owner, mint, recipient, positionId), ...(recipient === owner ? [closeWsolIx(web3, owner)] : [])];
}

export function buildTransferPosition(web3: typeof Web3, program: string, owner: string, mint: string, newOwner: string, positionId: string = owner): Web3.TransactionInstruction {
  const pool = poolAddress(web3, program, mint);
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(program),
    keys: [key(web3, owner, true, false), key(web3, pool, false, false), key(web3, positionAddress(web3, program, pool, positionId), false, true)],
    data: data(DISC.transferPosition, [{ key: new web3.PublicKey(newOwner).toBytes() }]),
  });
}

export function buildSetRecipient(web3: typeof Web3, program: string, owner: string, mint: string, recipient: string, positionId: string = owner): Web3.TransactionInstruction {
  const pool = poolAddress(web3, program, mint);
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(program),
    keys: [key(web3, owner, true, false), key(web3, pool, false, false), key(web3, positionAddress(web3, program, pool, positionId), false, true)],
    data: data(DISC.setRecipient, [{ key: new web3.PublicKey(recipient).toBytes() }]),
  });
}

export function buildLock(web3: typeof Web3, program: string, owner: string, mint: string, amount: bigint, positionId: string = owner): Web3.TransactionInstruction {
  const pool = poolAddress(web3, program, mint);
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(program),
    keys: [key(web3, owner, true, false), key(web3, pool, false, false), key(web3, positionAddress(web3, program, pool, positionId), false, true)],
    data: data(DISC.lockLiquidity, [{ u64: amount }]),
  });
}

export function assemble(web3: typeof Web3, instructions: Web3.TransactionInstruction[], payer: string, blockhash: string, lastValidBlockHeight: number): Web3.Transaction {
  const tx = new web3.Transaction({ feePayer: new web3.PublicKey(payer), blockhash, lastValidBlockHeight });
  tx.add(...instructions);
  return tx;
}

// ---------------------------------------------------------------- the check before signing

/** One expected account: its address and its flags ('S' signer, 'W' writable, '' neither). */
type Want = [string, string];
/** One expected step: the program, its exact data, and every account with its flags. */
interface Step {
  program: string;
  data: Uint8Array;
  accounts: Want[];
}

const pda = (web3: typeof Web3, program: string, seeds: Uint8Array[]): string => web3.PublicKey.findProgramAddressSync(seeds, new web3.PublicKey(program))[0].toBase58();
const pk = (web3: typeof Web3, a: string): Uint8Array => new web3.PublicKey(a).toBytes();
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
/** An associated token account, derived here from the seeds (not with the builder's helper). */
const assoc = (web3: typeof Web3, owner: string, mint: string, tokenProgram: string): string => pda(web3, ATA_PROGRAM_ID, [pk(web3, owner), pk(web3, tokenProgram), pk(web3, mint)]);

// The wrapper steps, written out byte for byte.
const ataStep = (web3: typeof Web3, payer: string, owner: string, mint: string, tokenProgram: string): Step => ({
  program: ATA_PROGRAM_ID,
  data: Uint8Array.from([1]),
  accounts: [[payer, 'SW'], [assoc(web3, owner, mint, tokenProgram), 'W'], [owner, ''], [mint, ''], [SYSTEM_PROGRAM_ID, ''], [tokenProgram, '']],
});
const wrapSteps = (web3: typeof Web3, owner: string, lamports: bigint): Step[] => {
  const t = new Uint8Array(12);
  view(t).setUint32(0, 2, true);
  view(t).setBigUint64(4, lamports, true);
  const acc = assoc(web3, owner, WSOL_MINT, TOKEN_PROGRAM_ID);
  return [
    ataStep(web3, owner, owner, WSOL_MINT, TOKEN_PROGRAM_ID),
    { program: SYSTEM_PROGRAM_ID, data: t, accounts: [[owner, 'SW'], [acc, 'W']] },
    { program: TOKEN_PROGRAM_ID, data: Uint8Array.from([17]), accounts: [[acc, 'W']] },
  ];
};
const closeStep = (web3: typeof Web3, owner: string): Step => ({
  program: TOKEN_PROGRAM_ID,
  data: Uint8Array.from([9]),
  accounts: [[assoc(web3, owner, WSOL_MINT, TOKEN_PROGRAM_ID), 'W'], [owner, 'W'], [owner, 'S']],
});

function matches(ix: Web3.TransactionInstruction, s: Step): boolean {
  if (ix.programId.toBase58() !== s.program || !bytesEqual(Uint8Array.from(ix.data), s.data) || ix.keys.length !== s.accounts.length) return false;
  return s.accounts.every(([address, flags], i) => {
    const k = ix.keys[i]!;
    return k.pubkey.toBase58() === address && `${k.isSigner ? 'S' : ''}${k.isWritable ? 'W' : ''}` === flags;
  });
}

/**
 * The checks every Aretia Pool transaction shares: the fee payer, the signers, the exact steps before and after the pool's own, and the
 * pool's step itself: the right program, tag, length, accounts and flags, and arguments (checked by `args`).
 */
function inspectPlan(
  tx: Web3.Transaction,
  payer: string,
  plan: { before: Step[]; after: Step[]; program: string; tag: Uint8Array; dataLen: number; accounts: Want[]; args: (d: Uint8Array) => string[]; allowedSigners?: string[] },
): string[] {
  const blockers: string[] = [];
  if (tx.feePayer?.toBase58() !== payer) blockers.push('The fee would be paid by an account other than yours.');
  const signers = new Set<string>();
  for (const ix of tx.instructions) for (const m of ix.keys) if (m.isSigner) signers.add(m.pubkey.toBase58());
  for (const s of signers) if (s !== payer && !(plan.allowedSigners ?? []).includes(s)) blockers.push(`An unexpected account would have to sign: ${s}.`);

  const steps = tx.instructions;
  const want = plan.before.length + 1 + plan.after.length;
  if (steps.length !== want) return [...blockers, 'The transaction is not the set of steps that was shown.'];
  plan.before.forEach((s, i) => {
    if (!matches(steps[i]!, s)) blockers.push(`Step ${i + 1} is not the expected wrapped-SOL or token-account step.`);
  });
  plan.after.forEach((s, i) => {
    const at = plan.before.length + 1 + i;
    if (!matches(steps[at]!, s)) blockers.push(`Step ${at + 1} is not the expected unwrap step.`);
  });
  const ix = steps[plan.before.length]!;
  if (ix.programId.toBase58() !== plan.program) return [...blockers, 'The pool step is not made by the pool program that was shown.'];
  const d = Uint8Array.from(ix.data);
  if (d.length !== plan.dataLen || !bytesEqual(d.subarray(0, 8), plan.tag)) return [...blockers, 'The pool step is not the expected one.'];
  if (ix.keys.length !== plan.accounts.length) return [...blockers, 'The pool step uses a different set of accounts than expected.'];
  plan.accounts.forEach(([address, flags], i) => {
    const k = ix.keys[i]!;
    const got = `${k.isSigner ? 'S' : ''}${k.isWritable ? 'W' : ''}`;
    if (k.pubkey.toBase58() !== address || got !== flags) blockers.push(`The pool step uses an unexpected account in position ${i + 1}.`);
  });
  return [...blockers, ...plan.args(d)];
}

/** A step that is only the pool's own (no wrapper steps). */
const alone = (): { before: Step[]; after: Step[] } => ({ before: [], after: [] });

export interface CreateCheck {
  params: CreateParams;
  program: string;
  /** The pool address shown to the creator. */
  pool: string;
  owner?: string;
  /** The position's id: the owner's address unless the position is opened under a key that signs for itself. */
  positionId?: string;
}

/** Reads a create-pool transaction back and compares it with what the review screen showed. Returns the reasons not to sign. */
export function inspectCreate(web3: typeof Web3, tx: Web3.Transaction, c: CreateCheck): string[] {
  const { params: p, program } = c;
  const owner = c.owner ?? p.creator;
  const id = c.positionId ?? owner;
  const pool = pda(web3, program, [text('pool'), pk(web3, p.mint)]);
  const blockers: string[] = [];
  if (pool !== c.pool) blockers.push('The pool address is not the one shown.');
  const accounts: Want[] = [
    [p.creator, 'SW'],
    [owner, ''],
    [p.mint, ''],
    [assoc(web3, p.creator, p.mint, TOKEN_2022_PROGRAM_ID), 'W'],
    [pool, 'W'],
    [assoc(web3, pool, WSOL_MINT, TOKEN_PROGRAM_ID), 'W'],
    [assoc(web3, pool, p.mint, TOKEN_2022_PROGRAM_ID), 'W'],
    [pda(web3, program, [text('position'), pk(web3, pool), pk(web3, id)]), 'W'],
    [ARETIA_POOL_FEE_ADDRESS, 'W'],
    [TOKEN_2022_PROGRAM_ID, ''],
    [ATA_PROGRAM_ID, ''],
    [SYSTEM_PROGRAM_ID, ''],
    [id, id !== owner ? 'S' : ''],
    [WSOL_MINT, ''],
    [assoc(web3, p.creator, WSOL_MINT, TOKEN_PROGRAM_ID), 'W'],
    [TOKEN_PROGRAM_ID, ''],
  ];
  const before = [ataStep(web3, p.creator, ARETIA_POOL_FEE_ADDRESS, WSOL_MINT, TOKEN_PROGRAM_ID), ...(p.y0 > 0n ? wrapSteps(web3, p.creator, p.y0) : [])];
  const after = p.y0 > 0n ? [closeStep(web3, p.creator)] : [];
  return [
    ...blockers,
    ...inspectPlan(tx, p.creator, {
      before,
      after,
      program,
      tag: DISC.createPool,
      dataLen: 8 + 8 + 8 + 8 + 2 + 1 + 2 + 4 + 8,
      accounts,
      allowedSigners: id !== owner ? [id] : [],
      args: (d) => {
        const v = view(d);
        const out: string[] = [];
        if (v.getBigUint64(8, true) !== p.x0) out.push('The amount of tokens going in is not the one shown.');
        if (v.getBigUint64(16, true) !== p.y0) out.push('The amount of SOL going in is not the one shown.');
        if (v.getBigUint64(24, true) !== p.l0) out.push('The starting price is not the one shown.');
        if (v.getUint16(32, true) !== p.feeBps) out.push('The trading fee is not the one shown.');
        if (d[34] !== (p.lock ? 1 : 0)) out.push(p.lock ? 'The liquidity would not be locked.' : 'The liquidity would be locked, which was not chosen.');
        if (v.getUint16(35, true) !== p.sniperBps || v.getUint32(37, true) !== p.decaySecs) out.push('The launch protection is not the one shown.');
        if (v.getBigUint64(41, true) !== p.vx0) out.push('The price range is not the one shown.');
        return out;
      },
    }),
  ];
}

export interface SwapCheck extends SwapParams {
  program: string;
}

export function inspectSwap(web3: typeof Web3, tx: Web3.Transaction, c: SwapCheck): string[] {
  const pool = pda(web3, c.program, [text('pool'), pk(web3, c.mint)]);
  const accounts: Want[] = [
    [c.trader, 'SW'],
    [pool, 'W'],
    [assoc(web3, pool, WSOL_MINT, TOKEN_PROGRAM_ID), 'W'],
    [c.mint, ''],
    [assoc(web3, pool, c.mint, TOKEN_2022_PROGRAM_ID), 'W'],
    [assoc(web3, c.trader, c.mint, TOKEN_2022_PROGRAM_ID), 'W'],
    [assoc(web3, c.trader, WSOL_MINT, TOKEN_PROGRAM_ID), 'W'],
    [assoc(web3, ARETIA_POOL_FEE_ADDRESS, WSOL_MINT, TOKEN_PROGRAM_ID), 'W'],
    [TOKEN_2022_PROGRAM_ID, ''],
    [TOKEN_PROGRAM_ID, ''],
  ];
  const before = c.isBuy ? [ataStep(web3, c.trader, c.trader, c.mint, TOKEN_2022_PROGRAM_ID), ...wrapSteps(web3, c.trader, c.amountIn)] : [ataStep(web3, c.trader, c.trader, WSOL_MINT, TOKEN_PROGRAM_ID)];
  return inspectPlan(tx, c.trader, {
    before,
    after: [closeStep(web3, c.trader)],
    program: c.program,
    tag: DISC.swap,
    dataLen: 8 + 1 + 8 + 8,
    accounts,
    args: (d) => {
      const v = view(d);
      const out: string[] = [];
      if (d[8] !== (c.isBuy ? 1 : 0)) out.push('The direction of the trade is not the one shown.');
      if (v.getBigUint64(9, true) !== c.amountIn) out.push('The amount being traded is not the one shown.');
      if (v.getBigUint64(17, true) !== c.minOut) out.push('The minimum you receive is not the one shown.');
      if (c.minOut === 0n) out.push('There is no minimum on what you receive.');
      return out;
    },
  });
}

export function inspectClaim(web3: typeof Web3, tx: Web3.Transaction, c: { program: string; owner: string; mint: string; recipient?: string; positionId?: string }): string[] {
  const pool = pda(web3, c.program, [text('pool'), pk(web3, c.mint)]);
  const recipient = c.recipient ?? c.owner;
  const accounts: Want[] = [
    [c.owner, 'SW'],
    [pool, 'W'],
    [assoc(web3, pool, WSOL_MINT, TOKEN_PROGRAM_ID), 'W'],
    [pda(web3, c.program, [text('position'), pk(web3, pool), pk(web3, c.positionId ?? c.owner)]), 'W'],
    [assoc(web3, recipient, WSOL_MINT, TOKEN_PROGRAM_ID), 'W'],
    [TOKEN_PROGRAM_ID, ''],
  ];
  return inspectPlan(tx, c.owner, {
    before: [ataStep(web3, c.owner, recipient, WSOL_MINT, TOKEN_PROGRAM_ID)],
    after: recipient === c.owner ? [closeStep(web3, c.owner)] : [],
    program: c.program,
    tag: DISC.claimFees,
    dataLen: 8,
    accounts,
    args: () => [],
  });
}

export function inspectLock(web3: typeof Web3, tx: Web3.Transaction, c: { program: string; owner: string; mint: string; amount: bigint; positionId?: string }): string[] {
  const pool = pda(web3, c.program, [text('pool'), pk(web3, c.mint)]);
  const accounts: Want[] = [
    [c.owner, 'S'],
    [pool, ''],
    [pda(web3, c.program, [text('position'), pk(web3, pool), pk(web3, c.positionId ?? c.owner)]), 'W'],
  ];
  return inspectPlan(tx, c.owner, { ...alone(), program: c.program, tag: DISC.lockLiquidity, dataLen: 16, accounts, args: (d) => (view(d).getBigUint64(8, true) === c.amount ? [] : ['The amount being locked is not the one shown.']) });
}

function inspectLiquidity(web3: typeof Web3, tx: Web3.Transaction, program: string, tag: Uint8Array, l: LiquidityParams, add: boolean): string[] {
  const pool = pda(web3, program, [text('pool'), pk(web3, l.mint)]);
  const id = l.positionId ?? l.owner;
  const accounts: Want[] = [
    [l.owner, 'SW'],
    [pool, 'W'],
    [assoc(web3, pool, WSOL_MINT, TOKEN_PROGRAM_ID), 'W'],
    [l.mint, ''],
    [assoc(web3, pool, l.mint, TOKEN_2022_PROGRAM_ID), 'W'],
    [assoc(web3, l.owner, l.mint, TOKEN_2022_PROGRAM_ID), 'W'],
    [pda(web3, program, [text('position'), pk(web3, pool), pk(web3, id)]), 'W'],
    [TOKEN_2022_PROGRAM_ID, ''],
    [SYSTEM_PROGRAM_ID, ''],
  ];
  if (add) accounts.push([id, id !== l.owner ? 'S' : '']);
  accounts.push([assoc(web3, l.owner, WSOL_MINT, TOKEN_PROGRAM_ID), 'W'], [TOKEN_PROGRAM_ID, '']);
  const before = add
    ? [ataStep(web3, l.owner, l.owner, l.mint, TOKEN_2022_PROGRAM_ID), ...wrapSteps(web3, l.owner, l.sol)]
    : [ataStep(web3, l.owner, l.owner, l.mint, TOKEN_2022_PROGRAM_ID), ataStep(web3, l.owner, l.owner, WSOL_MINT, TOKEN_PROGRAM_ID)];
  return inspectPlan(tx, l.owner, {
    before,
    after: [closeStep(web3, l.owner)],
    program,
    tag,
    dataLen: 8 + 24,
    accounts,
    allowedSigners: add && id !== l.owner ? [id] : [],
    args: (d) => {
      const v = view(d);
      const out: string[] = [];
      if (v.getBigUint64(8, true) !== l.dl) out.push('The amount of liquidity is not the one shown.');
      if (v.getBigUint64(16, true) !== l.tokens) out.push(add ? 'The most tokens you would pay is not the one shown.' : 'The least tokens you would accept is not the one shown.');
      if (v.getBigUint64(24, true) !== l.sol) out.push(add ? 'The most SOL you would pay is not the one shown.' : 'The least SOL you would accept is not the one shown.');
      return out;
    },
  });
}

export function inspectAddLiquidity(web3: typeof Web3, tx: Web3.Transaction, c: LiquidityParams & { program: string }): string[] {
  return inspectLiquidity(web3, tx, c.program, DISC.addLiquidity, c, true);
}

export function inspectRemoveLiquidity(web3: typeof Web3, tx: Web3.Transaction, c: LiquidityParams & { program: string }): string[] {
  return inspectLiquidity(web3, tx, c.program, DISC.removeLiquidity, c, false);
}

export function inspectSetRecipient(web3: typeof Web3, tx: Web3.Transaction, c: { program: string; owner: string; mint: string; recipient: string; positionId?: string }): string[] {
  const pool = pda(web3, c.program, [text('pool'), pk(web3, c.mint)]);
  const accounts: Want[] = [
    [c.owner, 'S'],
    [pool, ''],
    [pda(web3, c.program, [text('position'), pk(web3, pool), pk(web3, c.positionId ?? c.owner)]), 'W'],
  ];
  return inspectPlan(tx, c.owner, { ...alone(), program: c.program, tag: DISC.setRecipient, dataLen: 8 + 32, accounts, args: (d) => (bytesEqual(d.subarray(8, 40), pk(web3, c.recipient)) ? [] : ['The wallet that would receive the fees is not the one shown.']) });
}

export function inspectTransferPosition(web3: typeof Web3, tx: Web3.Transaction, c: { program: string; owner: string; mint: string; newOwner: string; positionId?: string }): string[] {
  const pool = pda(web3, c.program, [text('pool'), pk(web3, c.mint)]);
  const accounts: Want[] = [
    [c.owner, 'S'],
    [pool, ''],
    [pda(web3, c.program, [text('position'), pk(web3, pool), pk(web3, c.positionId ?? c.owner)]), 'W'],
  ];
  return inspectPlan(tx, c.owner, { ...alone(), program: c.program, tag: DISC.transferPosition, dataLen: 8 + 32, accounts, args: (d) => (bytesEqual(d.subarray(8, 40), pk(web3, c.newOwner)) ? [] : ['The wallet the position would go to is not the one shown.']) });
}
