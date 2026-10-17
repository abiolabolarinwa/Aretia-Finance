/**
 * Aretia Pool on the web wallet: the transactions, and a check of each before anyone signs.
 *
 * Unlike the Meteora pool (walletPoolTx.ts) there is no SDK to lean on: the program is Aretia's own and small, so each instruction is
 * written here by hand from the layout in program/aretia-pool, and the tests replay the same bytes through the compiled program.
 * What matters more is the check. The inspector reads the transaction back as raw bytes and does not use the builder: it derives
 * every address itself and refuses anything that is not exactly the one instruction that was shown, to the program that was shown,
 * with the accounts, flags and numbers that were shown, with no extra instruction and no extra signer.
 *
 * Every transaction here is one instruction. Creating a pool also pays Aretia's flat fee, but the program takes it itself, so there is
 * no separate transfer to check.
 */
import type * as Web3 from '@solana/web3.js';
import { ATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ataAddress } from './walletTools';
import { SYSTEM_PROGRAM_ID } from './walletLaunchTx';
import { ARETIA_POOL_FEE_ADDRESS, type CreateParams } from './walletAretiaPoolCore';

/** Anchor instruction tags: the first 8 bytes of sha256("global:<name>"). The tests recompute them. */
export const DISC = {
  createPool: Uint8Array.from([233, 146, 209, 142, 207, 104, 64, 188]),
  swap: Uint8Array.from([248, 198, 158, 145, 225, 117, 135, 200]),
  addLiquidity: Uint8Array.from([181, 157, 89, 67, 143, 182, 52, 72]),
  removeLiquidity: Uint8Array.from([80, 85, 209, 72, 24, 206, 177, 108]),
  claimFees: Uint8Array.from([82, 251, 233, 156, 12, 52, 184, 202]),
  lockLiquidity: Uint8Array.from([179, 201, 236, 158, 212, 98, 70, 182]),
  setRecipient: Uint8Array.from([133, 1, 115, 69, 206, 190, 17, 18]),
} as const;

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------- addresses

export function poolAddress(web3: typeof Web3, program: string, mint: string): string {
  return web3.PublicKey.findProgramAddressSync([Buffer.from('pool'), new web3.PublicKey(mint).toBytes()], new web3.PublicKey(program))[0].toBase58();
}
export function solVaultAddress(web3: typeof Web3, program: string, pool: string): string {
  return web3.PublicKey.findProgramAddressSync([Buffer.from('sol_vault'), new web3.PublicKey(pool).toBytes()], new web3.PublicKey(program))[0].toBase58();
}
export function positionAddress(web3: typeof Web3, program: string, pool: string, owner: string): string {
  return web3.PublicKey.findProgramAddressSync([Buffer.from('position'), new web3.PublicKey(pool).toBytes(), new web3.PublicKey(owner).toBytes()], new web3.PublicKey(program))[0].toBase58();
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

export interface BuiltCreate {
  instructions: Web3.TransactionInstruction[];
  pool: string;
  position: string;
  vault: string;
  solVault: string;
}

/** `owner` is who will own the position: the creator, on the Launch page. */
export function buildCreatePool(web3: typeof Web3, program: string, p: CreateParams, owner: string = p.creator): BuiltCreate {
  const pool = poolAddress(web3, program, p.mint);
  const solVault = solVaultAddress(web3, program, pool);
  const vault = ataAddress(web3, pool, p.mint, TOKEN_2022_PROGRAM_ID);
  const position = positionAddress(web3, program, pool, owner);
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
    ],
    data: data(DISC.createPool, [{ u64: p.x0 }, { u64: p.y0 }, { u64: p.l0 }, { u16: p.feeBps }, { bool: p.lock }, { u16: p.sniperBps }, { u32: p.decaySecs }]),
  });
  return { instructions: [ix], pool, position, vault, solVault };
}

export interface SwapParams {
  trader: string;
  mint: string;
  isBuy: boolean;
  amountIn: bigint;
  minOut: bigint;
}

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
      key(web3, ARETIA_POOL_FEE_ADDRESS, false, true),
      key(web3, TOKEN_2022_PROGRAM_ID, false, false),
      key(web3, SYSTEM_PROGRAM_ID, false, false),
    ],
    data: data(DISC.swap, [{ bool: s.isBuy }, { u64: s.amountIn }, { u64: s.minOut }]),
  });
}

export interface LiquidityParams {
  owner: string;
  mint: string;
  /** Liquidity to add or remove. */
  dl: bigint;
  /** Add: the most tokens and SOL the owner will pay. Remove: the least tokens and SOL the owner will accept. */
  tokens: bigint;
  sol: bigint;
}

function liquidityKeys(web3: typeof Web3, program: string, owner: string, mint: string): Web3.AccountMeta[] {
  const pool = poolAddress(web3, program, mint);
  return [
    key(web3, owner, true, true),
    key(web3, pool, false, true),
    key(web3, solVaultAddress(web3, program, pool), false, true),
    key(web3, mint, false, false),
    key(web3, ataAddress(web3, pool, mint, TOKEN_2022_PROGRAM_ID), false, true),
    key(web3, ataAddress(web3, owner, mint, TOKEN_2022_PROGRAM_ID), false, true),
    key(web3, positionAddress(web3, program, pool, owner), false, true),
    key(web3, TOKEN_2022_PROGRAM_ID, false, false),
    key(web3, SYSTEM_PROGRAM_ID, false, false),
  ];
}

export function buildAddLiquidity(web3: typeof Web3, program: string, l: LiquidityParams): Web3.TransactionInstruction {
  return new web3.TransactionInstruction({ programId: new web3.PublicKey(program), keys: liquidityKeys(web3, program, l.owner, l.mint), data: data(DISC.addLiquidity, [{ u64: l.dl }, { u64: l.tokens }, { u64: l.sol }]) });
}

export function buildRemoveLiquidity(web3: typeof Web3, program: string, l: LiquidityParams): Web3.TransactionInstruction {
  return new web3.TransactionInstruction({ programId: new web3.PublicKey(program), keys: liquidityKeys(web3, program, l.owner, l.mint), data: data(DISC.removeLiquidity, [{ u64: l.dl }, { u64: l.tokens }, { u64: l.sol }]) });
}

/** `recipient` is the wallet the position names to receive its fees (the owner unless changed). */
export function buildClaim(web3: typeof Web3, program: string, owner: string, mint: string, recipient: string = owner): Web3.TransactionInstruction {
  const pool = poolAddress(web3, program, mint);
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(program),
    keys: [
      key(web3, owner, true, true),
      key(web3, pool, false, true),
      key(web3, solVaultAddress(web3, program, pool), false, true),
      key(web3, positionAddress(web3, program, pool, owner), false, true),
      key(web3, recipient, false, true),
      key(web3, SYSTEM_PROGRAM_ID, false, false),
    ],
    data: data(DISC.claimFees, []),
  });
}

export function buildSetRecipient(web3: typeof Web3, program: string, owner: string, mint: string, recipient: string): Web3.TransactionInstruction {
  const pool = poolAddress(web3, program, mint);
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(program),
    keys: [key(web3, owner, true, false), key(web3, pool, false, false), key(web3, positionAddress(web3, program, pool, owner), false, true)],
    data: data(DISC.setRecipient, [{ key: new web3.PublicKey(recipient).toBytes() }]),
  });
}

export function buildLock(web3: typeof Web3, program: string, owner: string, mint: string, amount: bigint): Web3.TransactionInstruction {
  const pool = poolAddress(web3, program, mint);
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(program),
    keys: [key(web3, owner, true, false), key(web3, pool, false, false), key(web3, positionAddress(web3, program, pool, owner), false, true)],
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

/** The checks every Aretia Pool transaction shares: one instruction, the right program, the right accounts and flags, one signer. */
function inspectOne(
  tx: Web3.Transaction,
  payer: string,
  program: string,
  tag: Uint8Array,
  dataLen: number,
  accounts: Want[],
  args: (d: Uint8Array) => string[],
): string[] {
  const blockers: string[] = [];
  if (tx.feePayer?.toBase58() !== payer) blockers.push('The fee would be paid by an account other than yours.');
  const signers = new Set<string>();
  for (const ix of tx.instructions) for (const m of ix.keys) if (m.isSigner) signers.add(m.pubkey.toBase58());
  for (const s of signers) if (s !== payer) blockers.push(`An unexpected account would have to sign: ${s}.`);
  if (tx.instructions.length !== 1) return [...blockers, 'The transaction is not the single step that was shown.'];
  const ix = tx.instructions[0]!;
  if (ix.programId.toBase58() !== program) return [...blockers, 'The step is not made by the pool program that was shown.'];
  const d = Uint8Array.from(ix.data);
  if (d.length !== dataLen || !bytesEqual(d.subarray(0, 8), tag)) return [...blockers, 'The step is not the expected one.'];
  if (ix.keys.length !== accounts.length) return [...blockers, 'The step uses a different set of accounts than expected.'];
  accounts.forEach(([address, flags], i) => {
    const k = ix.keys[i]!;
    const got = `${k.isSigner ? 'S' : ''}${k.isWritable ? 'W' : ''}`;
    if (k.pubkey.toBase58() !== address || got !== flags) blockers.push(`The step uses an unexpected account in position ${i + 1}.`);
  });
  return [...blockers, ...args(d)];
}

const pda = (web3: typeof Web3, program: string, seeds: Uint8Array[]): string => web3.PublicKey.findProgramAddressSync(seeds, new web3.PublicKey(program))[0].toBase58();
const pk = (web3: typeof Web3, a: string): Uint8Array => new web3.PublicKey(a).toBytes();
const text = (s: string): Uint8Array => new TextEncoder().encode(s);
const associated = (web3: typeof Web3, owner: string, mint: string): string => pda(web3, ATA_PROGRAM_ID, [pk(web3, owner), pk(web3, TOKEN_2022_PROGRAM_ID), pk(web3, mint)]);

export interface CreateCheck {
  params: CreateParams;
  program: string;
  /** The pool address shown to the creator. */
  pool: string;
  owner?: string;
}

/** Reads a create-pool transaction back and compares it with what the review screen showed. Returns the reasons not to sign. */
export function inspectCreate(web3: typeof Web3, tx: Web3.Transaction, c: CreateCheck): string[] {
  const { params: p, program } = c;
  const owner = c.owner ?? p.creator;
  const pool = pda(web3, program, [text('pool'), pk(web3, p.mint)]);
  const blockers: string[] = [];
  if (pool !== c.pool) blockers.push('The pool address is not the one shown.');
  const accounts: Want[] = [
    [p.creator, 'SW'],
    [owner, ''],
    [p.mint, ''],
    [associated(web3, p.creator, p.mint), 'W'],
    [pool, 'W'],
    [pda(web3, program, [text('sol_vault'), pk(web3, pool)]), 'W'],
    [pda(web3, ATA_PROGRAM_ID, [pk(web3, pool), pk(web3, TOKEN_2022_PROGRAM_ID), pk(web3, p.mint)]), 'W'],
    [pda(web3, program, [text('position'), pk(web3, pool), pk(web3, owner)]), 'W'],
    [ARETIA_POOL_FEE_ADDRESS, 'W'],
    [TOKEN_2022_PROGRAM_ID, ''],
    [ATA_PROGRAM_ID, ''],
    [SYSTEM_PROGRAM_ID, ''],
  ];
  return [
    ...blockers,
    ...inspectOne(tx, p.creator, program, DISC.createPool, 8 + 8 + 8 + 8 + 2 + 1 + 2 + 4, accounts, (d) => {
      const v = view(d);
      const out: string[] = [];
      if (v.getBigUint64(8, true) !== p.x0) out.push('The amount of tokens going in is not the one shown.');
      if (v.getBigUint64(16, true) !== p.y0) out.push('The amount of SOL going in is not the one shown.');
      if (v.getBigUint64(24, true) !== p.l0) out.push('The starting price is not the one shown.');
      if (v.getUint16(32, true) !== p.feeBps) out.push('The trading fee is not the one shown.');
      if (d[34] !== (p.lock ? 1 : 0)) out.push(p.lock ? 'The liquidity would not be locked.' : 'The liquidity would be locked, which was not chosen.');
      if (v.getUint16(35, true) !== p.sniperBps || v.getUint32(37, true) !== p.decaySecs) out.push('The launch protection is not the one shown.');
      return out;
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
    [pda(web3, c.program, [text('sol_vault'), pk(web3, pool)]), 'W'],
    [c.mint, ''],
    [pda(web3, ATA_PROGRAM_ID, [pk(web3, pool), pk(web3, TOKEN_2022_PROGRAM_ID), pk(web3, c.mint)]), 'W'],
    [associated(web3, c.trader, c.mint), 'W'],
    [ARETIA_POOL_FEE_ADDRESS, 'W'],
    [TOKEN_2022_PROGRAM_ID, ''],
    [SYSTEM_PROGRAM_ID, ''],
  ];
  return inspectOne(tx, c.trader, c.program, DISC.swap, 8 + 1 + 8 + 8, accounts, (d) => {
    const v = view(d);
    const out: string[] = [];
    if (d[8] !== (c.isBuy ? 1 : 0)) out.push('The direction of the trade is not the one shown.');
    if (v.getBigUint64(9, true) !== c.amountIn) out.push('The amount being traded is not the one shown.');
    if (v.getBigUint64(17, true) !== c.minOut) out.push('The minimum you receive is not the one shown.');
    if (c.minOut === 0n) out.push('There is no minimum on what you receive.');
    return out;
  });
}

export function inspectClaim(web3: typeof Web3, tx: Web3.Transaction, c: { program: string; owner: string; mint: string; recipient?: string }): string[] {
  const pool = pda(web3, c.program, [text('pool'), pk(web3, c.mint)]);
  const accounts: Want[] = [
    [c.owner, 'SW'],
    [pool, 'W'],
    [pda(web3, c.program, [text('sol_vault'), pk(web3, pool)]), 'W'],
    [pda(web3, c.program, [text('position'), pk(web3, pool), pk(web3, c.owner)]), 'W'],
    [c.recipient ?? c.owner, 'W'],
    [SYSTEM_PROGRAM_ID, ''],
  ];
  return inspectOne(tx, c.owner, c.program, DISC.claimFees, 8, accounts, () => []);
}

export function inspectLock(web3: typeof Web3, tx: Web3.Transaction, c: { program: string; owner: string; mint: string; amount: bigint }): string[] {
  const pool = pda(web3, c.program, [text('pool'), pk(web3, c.mint)]);
  const accounts: Want[] = [
    [c.owner, 'S'],
    [pool, ''],
    [pda(web3, c.program, [text('position'), pk(web3, pool), pk(web3, c.owner)]), 'W'],
  ];
  return inspectOne(tx, c.owner, c.program, DISC.lockLiquidity, 16, accounts, (d) => (view(d).getBigUint64(8, true) === c.amount ? [] : ['The amount being locked is not the one shown.']));
}

function inspectLiquidity(web3: typeof Web3, tx: Web3.Transaction, program: string, tag: Uint8Array, l: LiquidityParams, add: boolean): string[] {
  const pool = pda(web3, program, [text('pool'), pk(web3, l.mint)]);
  const accounts: Want[] = [
    [l.owner, 'SW'],
    [pool, 'W'],
    [pda(web3, program, [text('sol_vault'), pk(web3, pool)]), 'W'],
    [l.mint, ''],
    [pda(web3, ATA_PROGRAM_ID, [pk(web3, pool), pk(web3, TOKEN_2022_PROGRAM_ID), pk(web3, l.mint)]), 'W'],
    [associated(web3, l.owner, l.mint), 'W'],
    [pda(web3, program, [text('position'), pk(web3, pool), pk(web3, l.owner)]), 'W'],
    [TOKEN_2022_PROGRAM_ID, ''],
    [SYSTEM_PROGRAM_ID, ''],
  ];
  return inspectOne(tx, l.owner, program, tag, 8 + 24, accounts, (d) => {
    const v = view(d);
    const out: string[] = [];
    if (v.getBigUint64(8, true) !== l.dl) out.push('The amount of liquidity is not the one shown.');
    if (v.getBigUint64(16, true) !== l.tokens) out.push(add ? 'The most tokens you would pay is not the one shown.' : 'The least tokens you would accept is not the one shown.');
    if (v.getBigUint64(24, true) !== l.sol) out.push(add ? 'The most SOL you would pay is not the one shown.' : 'The least SOL you would accept is not the one shown.');
    return out;
  });
}

export function inspectAddLiquidity(web3: typeof Web3, tx: Web3.Transaction, c: LiquidityParams & { program: string }): string[] {
  return inspectLiquidity(web3, tx, c.program, DISC.addLiquidity, c, true);
}

export function inspectRemoveLiquidity(web3: typeof Web3, tx: Web3.Transaction, c: LiquidityParams & { program: string }): string[] {
  return inspectLiquidity(web3, tx, c.program, DISC.removeLiquidity, c, false);
}

export function inspectSetRecipient(web3: typeof Web3, tx: Web3.Transaction, c: { program: string; owner: string; mint: string; recipient: string }): string[] {
  const pool = pda(web3, c.program, [text('pool'), pk(web3, c.mint)]);
  const accounts: Want[] = [
    [c.owner, 'S'],
    [pool, ''],
    [pda(web3, c.program, [text('position'), pk(web3, pool), pk(web3, c.owner)]), 'W'],
  ];
  return inspectOne(tx, c.owner, c.program, DISC.setRecipient, 8 + 32, accounts, (d) => (bytesEqual(d.subarray(8, 40), pk(web3, c.recipient)) ? [] : ['The wallet that would receive the fees is not the one shown.']));
}
