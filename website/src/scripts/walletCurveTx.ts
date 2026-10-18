/**
 * Aretia Launch on the web wallet: the transactions that talk to the Aretia curve program, and a check of each before anyone signs.
 *
 * Every instruction is written by hand here (the program is plain Anchor: an eight-byte name hash, then little-endian numbers).
 * The inspector reads the built transaction back as raw bytes, without the builders, and refuses anything that is not exactly what
 * the review screen showed: another program, another account, another amount, an extra instruction, an extra signer, a different
 * fee payer, a different fee wallet. The program address and the fee wallet come from constants, never from the page or the chain.
 *
 * The transactions:
 *   create   create_curve, and optionally the creator's own first buy in the same transaction (the only way to be first)
 *   buy      create the buyer's token account if it is missing, then buy
 *   sell     sell
 *   migrate  a compute limit, then migrate (the position's NFT key signs alongside the wallet and is then dropped)
 *   abort    abort_migration
 */
import type * as Web3 from '@solana/web3.js';
import { ATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ataAddress } from './walletTools';
import { SYSTEM_PROGRAM_ID } from './walletLaunchTx';
import { WSOL_MINT } from './walletPoolCore';
import { METEORA_POOL_AUTHORITY, METEORA_PROGRAM_ID } from './walletPoolTx';
import { CURVE_FEE_ADDRESS, CURVE_MAX_RENT_BUDGET, type CurveConfig } from './walletCurveCore';

const DISC = {
  createCurve: Uint8Array.from([169, 235, 221, 223, 65, 109, 120, 183]),
  buy: Uint8Array.from([102, 6, 61, 18, 1, 218, 235, 234]),
  sell: Uint8Array.from([51, 230, 133, 164, 1, 127, 131, 173]),
  migrate: Uint8Array.from([155, 234, 231, 146, 236, 158, 162, 30]),
  abort: Uint8Array.from([115, 185, 103, 70, 138, 202, 43, 40]),
  claimPoolFees: Uint8Array.from([33, 187, 125, 186, 41, 247, 236, 89]),
};
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
/** Compute units asked for by a migration. The test VM measured about 207,000; this leaves room for Meteora to cost more. */
export const MIGRATE_COMPUTE_UNITS = 400_000;

// ---------------------------------------------------------------- addresses

const key = (web3: typeof Web3, a: string) => new web3.PublicKey(a);
function pda(web3: typeof Web3, seeds: (Uint8Array | Buffer)[], program: string): string {
  return web3.PublicKey.findProgramAddressSync(seeds, key(web3, program))[0].toBase58();
}
const text = (s: string) => Buffer.from(s);

export const curveAddress = (web3: typeof Web3, program: string, mint: string) => pda(web3, [text('curve'), key(web3, mint).toBytes()], program);
export const solVaultAddress = (web3: typeof Web3, program: string, curve: string) => pda(web3, [text('sol_vault'), key(web3, curve).toBytes()], program);
export const migratorAddress = (web3: typeof Web3, program: string, curve: string) => pda(web3, [text('migrator'), key(web3, curve).toBytes()], program);
export const tokenVaultAddress = (web3: typeof Web3, curve: string, mint: string) => ataAddress(web3, curve, mint, TOKEN_2022_PROGRAM_ID);

/** Meteora's customizable-pool address for a token against wrapped SOL: seeds "cpool", the larger key, the smaller key. */
export function meteoraPoolAddress(web3: typeof Web3, mint: string): string {
  const a = key(web3, mint).toBytes();
  const b = key(web3, WSOL_MINT).toBytes();
  const aBigger = Buffer.compare(Buffer.from(a), Buffer.from(b)) === 1;
  return pda(web3, [text('cpool'), aBigger ? a : b, aBigger ? b : a], METEORA_PROGRAM_ID);
}
const meteoraEventAuthority = (web3: typeof Web3) => pda(web3, [text('__event_authority')], METEORA_PROGRAM_ID);

export interface MigrateAddresses {
  pool: string;
  position: string;
  nftAccount: string;
  vaultA: string;
  vaultB: string;
}
export function migrateAddresses(web3: typeof Web3, mint: string, nft: string): MigrateAddresses {
  const pool = meteoraPoolAddress(web3, mint);
  return {
    pool,
    position: pda(web3, [text('position'), key(web3, nft).toBytes()], METEORA_PROGRAM_ID),
    nftAccount: pda(web3, [text('position_nft_account'), key(web3, nft).toBytes()], METEORA_PROGRAM_ID),
    vaultA: pda(web3, [text('token_vault'), key(web3, mint).toBytes(), key(web3, pool).toBytes()], METEORA_PROGRAM_ID),
    vaultB: pda(web3, [text('token_vault'), key(web3, WSOL_MINT).toBytes(), key(web3, pool).toBytes()], METEORA_PROGRAM_ID),
  };
}

// ---------------------------------------------------------------- encoding

function u64le(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 64n) throw new Error('A number does not fit in 64 bits.');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, v, true);
  return out;
}
function u128le(v: bigint): Uint8Array {
  if (v < 0n || v >= 1n << 128n) throw new Error('A number does not fit in 128 bits.');
  const out = new Uint8Array(16);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(0, v & ((1n << 64n) - 1n), true);
  dv.setBigUint64(8, v >> 64n, true);
  return out;
}
const concat = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts);

type Meta = [address: string, flags: '' | 'W' | 'S' | 'SW'];
function ix(web3: typeof Web3, program: string, metas: Meta[], data: Uint8Array): Web3.TransactionInstruction {
  return new web3.TransactionInstruction({
    programId: key(web3, program),
    keys: metas.map(([a, f]) => ({ pubkey: key(web3, a), isSigner: f.includes('S'), isWritable: f.includes('W') })),
    data: Buffer.from(data),
  });
}

// ---------------------------------------------------------------- builders

/** The accounts of a buy or a sell, in the program's order. */
function tradeMetas(web3: typeof Web3, program: string, trader: string, mint: string): Meta[] {
  const curve = curveAddress(web3, program, mint);
  return [
    [trader, 'SW'],
    [curve, 'W'],
    [solVaultAddress(web3, program, curve), 'W'],
    [mint, ''],
    [tokenVaultAddress(web3, curve, mint), 'W'],
    [ataAddress(web3, trader, mint, TOKEN_2022_PROGRAM_ID), 'W'],
    [CURVE_FEE_ADDRESS, 'W'],
    [TOKEN_2022_PROGRAM_ID, ''],
    [SYSTEM_PROGRAM_ID, ''],
  ];
}

export function buyInstruction(web3: typeof Web3, program: string, buyer: string, mint: string, gross: bigint, minTokensOut: bigint): Web3.TransactionInstruction {
  return ix(web3, program, tradeMetas(web3, program, buyer, mint), concat(DISC.buy, u64le(gross), u64le(minTokensOut)));
}
export function sellInstruction(web3: typeof Web3, program: string, seller: string, mint: string, tokens: bigint, minLamportsOut: bigint): Web3.TransactionInstruction {
  return ix(web3, program, tradeMetas(web3, program, seller, mint), concat(DISC.sell, u64le(tokens), u64le(minLamportsOut)));
}

export function createCurveInstruction(web3: typeof Web3, program: string, creator: string, mint: string, totalRaw: bigint, targetLamports: bigint): Web3.TransactionInstruction {
  const curve = curveAddress(web3, program, mint);
  return ix(
    web3,
    program,
    [
      [creator, 'SW'],
      [mint, ''],
      [ataAddress(web3, creator, mint, TOKEN_2022_PROGRAM_ID), 'W'],
      [curve, 'W'],
      [solVaultAddress(web3, program, curve), 'W'],
      [tokenVaultAddress(web3, curve, mint), 'W'],
      [TOKEN_2022_PROGRAM_ID, ''],
      [ATA_PROGRAM_ID, ''],
      [SYSTEM_PROGRAM_ID, ''],
    ],
    concat(DISC.createCurve, u64le(totalRaw), u64le(targetLamports)),
  );
}

export function abortInstruction(web3: typeof Web3, program: string, caller: string, mint: string): Web3.TransactionInstruction {
  // The token's Meteora pool rides along, read-only: if someone else has already opened it, the program lets holders unwind at once.
  return ix(web3, program, [[caller, 'S'], [curveAddress(web3, program, mint), 'W'], [meteoraPoolAddress(web3, mint), '']], DISC.abort);
}

export interface MigrateArgs {
  rentBudget: bigint;
  liquidity: bigint;
  sqrtPrice: bigint;
}

export function computeLimitInstruction(web3: typeof Web3, units: number): Web3.TransactionInstruction {
  const d = Buffer.alloc(5);
  d[0] = 2;
  d.writeUInt32LE(units, 1);
  return new web3.TransactionInstruction({ programId: key(web3, COMPUTE_BUDGET_PROGRAM_ID), keys: [], data: d });
}

export function migrateInstruction(web3: typeof Web3, program: string, payer: string, mint: string, nft: string, args: MigrateArgs): Web3.TransactionInstruction {
  const curve = curveAddress(web3, program, mint);
  const migrator = migratorAddress(web3, program, curve);
  const m = migrateAddresses(web3, mint, nft);
  return ix(
    web3,
    program,
    [
      [payer, 'SW'],
      [curve, 'W'],
      [solVaultAddress(web3, program, curve), 'W'],
      [mint, ''],
      [tokenVaultAddress(web3, curve, mint), 'W'],
      [migrator, 'W'],
      [ataAddress(web3, migrator, mint, TOKEN_2022_PROGRAM_ID), 'W'],
      [WSOL_MINT, ''],
      [ataAddress(web3, migrator, WSOL_MINT, TOKEN_PROGRAM_ID), 'W'],
      [nft, 'SW'],
      [m.nftAccount, 'W'],
      [m.position, 'W'],
      [m.pool, 'W'],
      [m.vaultA, 'W'],
      [m.vaultB, 'W'],
      [METEORA_POOL_AUTHORITY, ''],
      [meteoraEventAuthority(web3), ''],
      [METEORA_PROGRAM_ID, ''],
      [TOKEN_2022_PROGRAM_ID, ''],
      [TOKEN_PROGRAM_ID, ''],
      [ATA_PROGRAM_ID, ''],
      [SYSTEM_PROGRAM_ID, ''],
    ],
    concat(DISC.migrate, u64le(args.rentBudget), u128le(args.liquidity), u128le(args.sqrtPrice)),
  );
}

/** Creates the buyer's token account for the mint if it is missing; harmless if it exists. */
function ataIdempotent(web3: typeof Web3, payer: string, owner: string, mint: string): Web3.TransactionInstruction {
  const ata = ataAddress(web3, owner, mint, TOKEN_2022_PROGRAM_ID);
  return ix(web3, ATA_PROGRAM_ID, [[payer, 'SW'], [ata, 'W'], [owner, ''], [mint, ''], [SYSTEM_PROGRAM_ID, ''], [TOKEN_2022_PROGRAM_ID, '']], Uint8Array.of(1));
}

export interface CreateInput {
  config: CurveConfig;
  /** The least tokens the creator's own first buy must give; ignored when there is no first buy. */
  firstBuyMinOut: bigint;
}
export const buildCreate = (web3: typeof Web3, program: string, i: CreateInput): Web3.TransactionInstruction[] => {
  const { config } = i;
  const list = [createCurveInstruction(web3, program, config.creator, config.mint, config.totalRaw, config.targetLamports)];
  if (config.firstBuyLamports > 0n) list.push(buyInstruction(web3, program, config.creator, config.mint, config.firstBuyLamports, i.firstBuyMinOut));
  return list;
};
export const buildBuy = (web3: typeof Web3, program: string, buyer: string, mint: string, gross: bigint, minTokensOut: bigint): Web3.TransactionInstruction[] => [
  ataIdempotent(web3, buyer, buyer, mint),
  buyInstruction(web3, program, buyer, mint, gross, minTokensOut),
];
export const buildSell = (web3: typeof Web3, program: string, seller: string, mint: string, tokens: bigint, minLamportsOut: bigint): Web3.TransactionInstruction[] => [
  sellInstruction(web3, program, seller, mint, tokens, minLamportsOut),
];
export const buildMigrate = (web3: typeof Web3, program: string, payer: string, mint: string, nft: string, args: MigrateArgs): Web3.TransactionInstruction[] => [
  computeLimitInstruction(web3, MIGRATE_COMPUTE_UNITS),
  migrateInstruction(web3, program, payer, mint, nft, args),
];
/** Aretia's fee wallet's wrapped-SOL account: where a graduated pool's fees are paid. */
export const feeWsolAddress = (web3: typeof Web3): string => ataAddress(web3, CURVE_FEE_ADDRESS, WSOL_MINT, TOKEN_PROGRAM_ID);

/** The accounts of `claim_pool_fees`, in the program's order. `nft` is the graduated position's NFT mint. */
function claimFeesMetas(web3: typeof Web3, program: string, caller: string, mint: string, nft: string): [string, '' | 'W' | 'S' | 'SW', string][] {
  const curve = curveAddress(web3, program, mint);
  const migrator = migratorAddress(web3, program, curve);
  const m = migrateAddresses(web3, mint, nft);
  return [
    [caller, 'SW', 'the caller'],
    [curve, '', 'the curve'],
    [mint, '', 'the token'],
    [migrator, '', 'the migrator'],
    [ataAddress(web3, migrator, mint, TOKEN_2022_PROGRAM_ID), 'W', 'the migrator’s token account'],
    [ataAddress(web3, migrator, WSOL_MINT, TOKEN_PROGRAM_ID), 'W', 'the migrator’s wrapped-SOL account'],
    [WSOL_MINT, '', 'wrapped SOL'],
    [CURVE_FEE_ADDRESS, '', 'the Aretia fee wallet'],
    [feeWsolAddress(web3), 'W', 'the Aretia fee wallet’s wrapped-SOL account'],
    [m.pool, 'W', 'the pool'],
    [m.position, 'W', 'the position'],
    [m.vaultA, 'W', 'the pool’s token vault'],
    [m.vaultB, 'W', 'the pool’s SOL vault'],
    [m.nftAccount, '', 'the position’s token account'],
    [METEORA_POOL_AUTHORITY, '', 'the pool authority'],
    [meteoraEventAuthority(web3), '', 'the pool event authority'],
    [METEORA_PROGRAM_ID, '', 'the pool program'],
    [TOKEN_2022_PROGRAM_ID, '', 'the token program'],
    [TOKEN_PROGRAM_ID, '', 'the wrapped-SOL token program'],
    [ATA_PROGRAM_ID, '', 'the token-account program'],
    [SYSTEM_PROGRAM_ID, '', 'the system program'],
  ];
}

/** Claims a graduated pool's fees for Aretia. Anyone may send it; the program pays only Aretia's fee wallet. */
export function claimFeesInstruction(web3: typeof Web3, program: string, caller: string, mint: string, nft: string): Web3.TransactionInstruction {
  return ix(web3, program, claimFeesMetas(web3, program, caller, mint, nft).map(([a, f]) => [a, f]), DISC.claimPoolFees);
}
export const buildClaimFees = (web3: typeof Web3, program: string, caller: string, mint: string, nft: string): Web3.TransactionInstruction[] => [claimFeesInstruction(web3, program, caller, mint, nft)];

export interface ClaimFeesCheck {
  program: string;
  caller: string;
  mint: string;
  nft: string;
}

export function inspectClaimFees(web3: typeof Web3, tx: Web3.Transaction, c: ClaimFeesCheck): string[] {
  const blockers = checkEnvelope(tx, { program: c.program, payer: c.caller });
  if (tx.instructions.length !== 1) return [...blockers, 'The transaction is not the expected set of steps.'];
  const a = tx.instructions[0]!;
  if (a.programId.toBase58() !== c.program || !bytesEqual(Uint8Array.from(a.data), DISC.claimPoolFees)) return [...blockers, 'The step is not the expected one.'];
  blockers.push(...checkAccounts(a, claimFeesMetas(web3, c.program, c.caller, c.mint, c.nft), 'fee claim'));
  return blockers;
}

export const buildAbort = (web3: typeof Web3, program: string, caller: string, mint: string): Web3.TransactionInstruction[] => [abortInstruction(web3, program, caller, mint)];

export function assembleCurve(web3: typeof Web3, instructions: Web3.TransactionInstruction[], payer: string, blockhash: string, lastValidBlockHeight: number): Web3.Transaction {
  const tx = new web3.Transaction({ feePayer: new web3.PublicKey(payer), blockhash, lastValidBlockHeight });
  tx.add(...instructions);
  return tx;
}

// ---------------------------------------------------------------- the check before signing

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const bytesEqual = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const u64at = (d: Uint8Array, at: number) => view(d).getBigUint64(at, true);
const u128at = (d: Uint8Array, at: number): bigint => u64at(d, at) | (u64at(d, at + 8) << 64n);

interface Expected {
  /** The program address, from a constant. */
  program: string;
  payer: string;
  /** Other accounts that must sign (the position NFT key for a migration). */
  extraSigners?: string[];
}

function checkEnvelope(tx: Web3.Transaction, e: Expected): string[] {
  const blockers: string[] = [];
  if (tx.feePayer?.toBase58() !== e.payer) blockers.push('The fee would be paid by an account other than yours.');
  const allowed = new Set([e.payer, ...(e.extraSigners ?? [])]);
  const signers = new Set<string>();
  for (const i of tx.instructions) for (const m of i.keys) if (m.isSigner) signers.add(m.pubkey.toBase58());
  for (const s of signers) if (!allowed.has(s)) blockers.push(`An unexpected account would have to sign: ${s}.`);
  return blockers;
}

/** Compares an instruction's accounts with an expected list, naming each mismatch in plain words. */
function checkAccounts(i: Web3.TransactionInstruction, expected: [address: string, flags: '' | 'W' | 'S' | 'SW', label: string][], what: string): string[] {
  if (i.keys.length !== expected.length) return [`The ${what} step has the wrong number of accounts.`];
  const out: string[] = [];
  expected.forEach(([address, flags, label], n) => {
    const k = i.keys[n]!;
    const got = `${k.isSigner ? 'S' : ''}${k.isWritable ? 'W' : ''}`;
    if (k.pubkey.toBase58() !== address || got !== flags) out.push(`The ${what} step uses an unexpected account for ${label}.`);
  });
  return out;
}

export interface TradeCheck {
  program: string;
  trader: string;
  mint: string;
  /** What the review screen showed: SOL offered or tokens handed back, and the least accepted in return. */
  amount: bigint;
  minOut: bigint;
}

function tradeExpected(web3: typeof Web3, c: TradeCheck): [string, '' | 'W' | 'S' | 'SW', string][] {
  const curve = curveAddress(web3, c.program, c.mint);
  return [
    [c.trader, 'SW', 'the trader'],
    [curve, 'W', 'the curve'],
    [solVaultAddress(web3, c.program, curve), 'W', 'the SOL vault'],
    [c.mint, '', 'the token'],
    [tokenVaultAddress(web3, curve, c.mint), 'W', 'the token vault'],
    [ataAddress(web3, c.trader, c.mint, TOKEN_2022_PROGRAM_ID), 'W', 'your token account'],
    [CURVE_FEE_ADDRESS, 'W', 'the Aretia fee'],
    [TOKEN_2022_PROGRAM_ID, '', 'the token program'],
    [SYSTEM_PROGRAM_ID, '', 'the system program'],
  ];
}

function checkTradeInstruction(web3: typeof Web3, i: Web3.TransactionInstruction | undefined, c: TradeCheck, disc: Uint8Array, what: string): string[] {
  if (!i || i.programId.toBase58() !== c.program) return [`The ${what} step is not made by the curve program.`];
  const d = Uint8Array.from(i.data);
  if (d.length !== 24 || !bytesEqual(d.subarray(0, 8), disc)) return [`The ${what} step is not the expected one.`];
  const out = checkAccounts(i, tradeExpected(web3, c), what);
  if (u64at(d, 8) !== c.amount) out.push(`The ${what} amount is not the one shown.`);
  if (u64at(d, 16) !== c.minOut) out.push(`The least you would accept is not the one shown.`);
  return out;
}

export function inspectBuy(web3: typeof Web3, tx: Web3.Transaction, c: TradeCheck): string[] {
  const blockers = checkEnvelope(tx, { program: c.program, payer: c.trader });
  if (tx.instructions.length !== 2) return [...blockers, 'The transaction is not the expected set of steps.'];
  const [ata, buy] = tx.instructions as [Web3.TransactionInstruction, Web3.TransactionInstruction];
  const want = ataAddress(web3, c.trader, c.mint, TOKEN_2022_PROGRAM_ID);
  if (ata.programId.toBase58() !== ATA_PROGRAM_ID || !bytesEqual(Uint8Array.from(ata.data), Uint8Array.of(1))) blockers.push('The first step is not the token-account step.');
  else
    blockers.push(
      ...checkAccounts(
        ata,
        [
          [c.trader, 'SW', 'the payer'],
          [want, 'W', 'your token account'],
          [c.trader, '', 'its owner'],
          [c.mint, '', 'the token'],
          [SYSTEM_PROGRAM_ID, '', 'the system program'],
          [TOKEN_2022_PROGRAM_ID, '', 'the token program'],
        ],
        'token-account',
      ),
    );
  blockers.push(...checkTradeInstruction(web3, buy, c, DISC.buy, 'buy'));
  return blockers;
}

export function inspectSell(web3: typeof Web3, tx: Web3.Transaction, c: TradeCheck): string[] {
  const blockers = checkEnvelope(tx, { program: c.program, payer: c.trader });
  if (tx.instructions.length !== 1) return [...blockers, 'The transaction is not the expected set of steps.'];
  blockers.push(...checkTradeInstruction(web3, tx.instructions[0], c, DISC.sell, 'sell'));
  return blockers;
}

export interface CreateCheck {
  program: string;
  config: CurveConfig;
  firstBuyMinOut: bigint;
}

export function inspectCreate(web3: typeof Web3, tx: Web3.Transaction, c: CreateCheck): string[] {
  const { config, program } = c;
  const blockers = checkEnvelope(tx, { program, payer: config.creator });
  const expectCount = config.firstBuyLamports > 0n ? 2 : 1;
  if (tx.instructions.length !== expectCount) return [...blockers, 'The transaction is not the expected set of steps.'];
  const create = tx.instructions[0]!;
  const curve = curveAddress(web3, program, config.mint);
  if (create.programId.toBase58() !== program) return [...blockers, 'The first step is not made by the curve program.'];
  const d = Uint8Array.from(create.data);
  if (d.length !== 24 || !bytesEqual(d.subarray(0, 8), DISC.createCurve)) return [...blockers, 'The first step is not the expected one.'];
  blockers.push(
    ...checkAccounts(
      create,
      [
        [config.creator, 'SW', 'the creator'],
        [config.mint, '', 'the token'],
        [ataAddress(web3, config.creator, config.mint, TOKEN_2022_PROGRAM_ID), 'W', 'your token account'],
        [curve, 'W', 'the curve'],
        [solVaultAddress(web3, program, curve), 'W', 'the SOL vault'],
        [tokenVaultAddress(web3, curve, config.mint), 'W', 'the token vault'],
        [TOKEN_2022_PROGRAM_ID, '', 'the token program'],
        [ATA_PROGRAM_ID, '', 'the token-account program'],
        [SYSTEM_PROGRAM_ID, '', 'the system program'],
      ],
      'create',
    ),
  );
  if (u64at(d, 8) !== config.totalRaw) blockers.push('The number of tokens going into the curve is not the one shown.');
  if (u64at(d, 16) !== config.targetLamports) blockers.push('The raise target is not the one shown.');
  if (config.firstBuyLamports > 0n) {
    blockers.push(...checkTradeInstruction(web3, tx.instructions[1], { program, trader: config.creator, mint: config.mint, amount: config.firstBuyLamports, minOut: c.firstBuyMinOut }, DISC.buy, 'first buy'));
  }
  return blockers;
}

export interface MigrateCheck {
  program: string;
  payer: string;
  mint: string;
  nft: string;
  args: MigrateArgs;
}

export function inspectMigrate(web3: typeof Web3, tx: Web3.Transaction, c: MigrateCheck): string[] {
  const blockers = checkEnvelope(tx, { program: c.program, payer: c.payer, extraSigners: [c.nft] });
  if (tx.instructions.length !== 2) return [...blockers, 'The transaction is not the expected set of steps.'];
  const [budget, mig] = tx.instructions as [Web3.TransactionInstruction, Web3.TransactionInstruction];

  const bd = Uint8Array.from(budget.data);
  if (budget.programId.toBase58() !== COMPUTE_BUDGET_PROGRAM_ID || budget.keys.length !== 0 || bd.length !== 5 || bd[0] !== 2 || view(bd).getUint32(1, true) !== MIGRATE_COMPUTE_UNITS)
    blockers.push('The first step is not a plain compute limit.');

  if (mig.programId.toBase58() !== c.program) return [...blockers, 'The second step is not made by the curve program.'];
  const d = Uint8Array.from(mig.data);
  if (d.length !== 48 || !bytesEqual(d.subarray(0, 8), DISC.migrate)) return [...blockers, 'The second step is not the expected one.'];
  const curve = curveAddress(web3, c.program, c.mint);
  const migrator = migratorAddress(web3, c.program, curve);
  const m = migrateAddresses(web3, c.mint, c.nft);
  blockers.push(
    ...checkAccounts(
      mig,
      [
        [c.payer, 'SW', 'the caller'],
        [curve, 'W', 'the curve'],
        [solVaultAddress(web3, c.program, curve), 'W', 'the SOL vault'],
        [c.mint, '', 'the token'],
        [tokenVaultAddress(web3, curve, c.mint), 'W', 'the token vault'],
        [migrator, 'W', 'the migrator'],
        [ataAddress(web3, migrator, c.mint, TOKEN_2022_PROGRAM_ID), 'W', 'the migrator’s token account'],
        [WSOL_MINT, '', 'wrapped SOL'],
        [ataAddress(web3, migrator, WSOL_MINT, TOKEN_PROGRAM_ID), 'W', 'the migrator’s wrapped-SOL account'],
        [c.nft, 'SW', 'the position key'],
        [m.nftAccount, 'W', 'the position’s token account'],
        [m.position, 'W', 'the position'],
        [m.pool, 'W', 'the pool'],
        [m.vaultA, 'W', 'the pool’s token vault'],
        [m.vaultB, 'W', 'the pool’s SOL vault'],
        [METEORA_POOL_AUTHORITY, '', 'the pool authority'],
        [meteoraEventAuthority(web3), '', 'the pool event authority'],
        [METEORA_PROGRAM_ID, '', 'the pool program'],
        [TOKEN_2022_PROGRAM_ID, '', 'the token program'],
        [TOKEN_PROGRAM_ID, '', 'the wrapped-SOL token program'],
        [ATA_PROGRAM_ID, '', 'the token-account program'],
        [SYSTEM_PROGRAM_ID, '', 'the system program'],
      ],
      'migrate',
    ),
  );
  const rent = u64at(d, 8);
  if (rent !== c.args.rentBudget) blockers.push('The amount lent for the pool’s accounts is not the one shown.');
  if (rent > CURVE_MAX_RENT_BUDGET) blockers.push('The amount lent for the pool’s accounts is above the limit.');
  if (u128at(d, 16) !== c.args.liquidity) blockers.push('The pool’s size is not the one worked out from the curve.');
  if (u128at(d, 32) !== c.args.sqrtPrice) blockers.push('The pool’s starting price is not the one worked out from the curve.');
  return blockers;
}

export interface AbortCheck {
  program: string;
  caller: string;
  mint: string;
}

export function inspectAbort(web3: typeof Web3, tx: Web3.Transaction, c: AbortCheck): string[] {
  const blockers = checkEnvelope(tx, { program: c.program, payer: c.caller });
  if (tx.instructions.length !== 1) return [...blockers, 'The transaction is not the expected set of steps.'];
  const a = tx.instructions[0]!;
  if (a.programId.toBase58() !== c.program || !bytesEqual(Uint8Array.from(a.data), DISC.abort)) return [...blockers, 'The step is not the expected one.'];
  blockers.push(
    ...checkAccounts(
      a,
      [
        [c.caller, 'S', 'the caller'],
        [curveAddress(web3, c.program, c.mint), 'W', 'the curve'],
        [meteoraPoolAddress(web3, c.mint), '', 'the pool the curve would move into'],
      ],
      'unwind',
    ),
  );
  return blockers;
}
