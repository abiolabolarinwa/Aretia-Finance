/**
 * Aretia Launch on the web wallet: the two transactions that create a token, and a check of them before anyone signs.
 *
 * Built with @solana/web3.js and no other library: the Token-2022 instructions are encoded here by hand. They are checked byte
 * for byte against the instructions the Aretia Wallet extension builds with the official Token-2022 client (see
 * walletLaunchTx.test.ts and its fixture), so the two products create identical tokens.
 *
 * Two transactions, because one does not reliably fit in Solana's 1232-byte limit with metadata and several recipients:
 *   1. create the mint, point its metadata at itself, initialise it, write the name, symbol and link
 *   2. create each recipient's token account, mint the supply, then give up the mint authority
 * Between the two the creator still holds the mint authority and the supply is zero. If the second fails, the creator can run it
 * again (see walletLaunchChain.ts): it refuses unless the supply is still zero, so it can never mint twice.
 *
 * Nothing here signs. The wallet signs as the fee payer and the page adds the new token's own key, which it then discards.
 */
import type * as Web3 from '@solana/web3.js';
import { ATA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ataAddress } from './walletTools';
import { distributionOf, shareOf, type DistributionLine, type LaunchConfig } from './walletLaunchCore';

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const RENT_SYSVAR_ID = 'SysvarRent111111111111111111111111111111111';

/** First eight bytes of every Token Metadata `Initialize` instruction (the interface's own discriminator). */
const METADATA_INITIALIZE = Uint8Array.from([210, 225, 30, 162, 88, 184, 77, 141]);
/** Token-2022 instruction numbers used here. */
const IX = { initializeMint: 0, setAuthority: 6, mintTo: 7, metadataPointer: 39 } as const;
const AUTHORITY_MINT = 0;

const utf8 = new TextEncoder();

// ---------------------------------------------------------------- sizes

/** Base Token-2022 mint account (165 bytes of padded account layout, one account-type byte) plus the metadata-pointer extension. */
const ALLOCATED_SIZE = 165 + 1 + (2 + 2 + 64);

export interface MintSizes {
  /** Space the account is created with. */
  allocated: number;
  /** Space once the metadata is written. Rent must cover this up front. */
  withMetadata: number;
}

export function mintSizes(config: Pick<LaunchConfig, 'name' | 'symbol' | 'metadataUri'>): MintSizes {
  const bytes = (s: string) => utf8.encode(s).length;
  // type + length, then update authority, mint, three length-prefixed strings and an empty list of extra fields.
  const metadata = 2 + 2 + (32 + 32 + 4 + bytes(config.name) + 4 + bytes(config.symbol) + 4 + bytes(config.metadataUri) + 4);
  return { allocated: ALLOCATED_SIZE, withMetadata: ALLOCATED_SIZE + metadata };
}

/** Token accounts made here carry the immutable-owner extension: 165 + account-type byte + one 4-byte extension header. */
export const TOKEN_ACCOUNT_SIZE = 165 + 1 + 4;

// ---------------------------------------------------------------- encoding

function u64le(value: bigint): Uint8Array {
  if (value < 0n || value >= 2n ** 64n) throw new RangeError('Amount does not fit in 64 bits.');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}
function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
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
const borshString = (s: string): Uint8Array => {
  const b = utf8.encode(s);
  return concat(u32le(b.length), b);
};

function keyOf(web3: typeof Web3, address: string, isSigner: boolean, isWritable: boolean): Web3.AccountMeta {
  return { pubkey: new web3.PublicKey(address), isSigner, isWritable };
}
function instruction(web3: typeof Web3, programId: string, keys: Web3.AccountMeta[], data: Uint8Array): Web3.TransactionInstruction {
  return new web3.TransactionInstruction({ programId: new web3.PublicKey(programId), keys, data: data as unknown as Buffer });
}

// ---------------------------------------------------------------- instructions

export interface Step1Input {
  config: LaunchConfig;
  /** The new token's address. */
  mint: string;
  /** Lamports to fund the token's account so it stays rent-exempt once the metadata is written. */
  mintRentLamports: bigint;
}

/** Transaction 1: create the token and write its name, symbol and link. */
export function buildStep1(web3: typeof Web3, { config, mint, mintRentLamports }: Step1Input): Web3.TransactionInstruction[] {
  const payer = config.creator;
  const sizes = mintSizes(config);
  const zero = new Uint8Array(32);
  const mintBytes = new web3.PublicKey(mint).toBytes();
  const payerBytes = new web3.PublicKey(payer).toBytes();

  // System program CreateAccount, encoded by hand so the deposit is a 64-bit integer end to end.
  const createAccount = instruction(
    web3,
    SYSTEM_PROGRAM_ID,
    [keyOf(web3, payer, true, true), keyOf(web3, mint, true, true)],
    concat(u32le(0), u64le(mintRentLamports), u64le(BigInt(sizes.allocated)), new web3.PublicKey(TOKEN_2022_PROGRAM_ID).toBytes()),
  );

  // Metadata pointer: no authority (it can never be repointed), and it points at the token itself.
  const pointer = instruction(web3, TOKEN_2022_PROGRAM_ID, [keyOf(web3, mint, false, true)], concat(Uint8Array.of(IX.metadataPointer, 0), zero, mintBytes));

  // InitializeMint: the creator holds the mint authority for now; there is never a freeze authority.
  const initMint = instruction(
    web3,
    TOKEN_2022_PROGRAM_ID,
    [keyOf(web3, mint, false, true), keyOf(web3, RENT_SYSVAR_ID, false, false)],
    concat(Uint8Array.of(IX.initializeMint, config.decimals), payerBytes, Uint8Array.of(0)),
  );

  // Token metadata. The all-zero address as update authority means nobody can ever change it.
  const metadata = instruction(
    web3,
    TOKEN_2022_PROGRAM_ID,
    [
      keyOf(web3, mint, false, true),
      keyOf(web3, config.metadataMutable ? payer : SYSTEM_PROGRAM_ID, false, false),
      keyOf(web3, mint, false, false),
      keyOf(web3, payer, true, false),
    ],
    concat(METADATA_INITIALIZE, borshString(config.name), borshString(config.symbol), borshString(config.metadataUri)),
  );
  return [createAccount, pointer, initMint, metadata];
}

/** Transaction 2: create the token accounts, mint the whole supply, and give up the mint authority. */
export function buildStep2(web3: typeof Web3, config: LaunchConfig, mint: string): Web3.TransactionInstruction[] {
  const payer = config.creator;
  const out: Web3.TransactionInstruction[] = [];
  for (const line of distributionOf(config)) {
    const ata = ataAddress(web3, line.owner, mint, TOKEN_2022_PROGRAM_ID);
    out.push(
      instruction(
        web3,
        ATA_PROGRAM_ID,
        [
          keyOf(web3, payer, true, true),
          keyOf(web3, ata, false, true),
          keyOf(web3, line.owner, false, false),
          keyOf(web3, mint, false, false),
          keyOf(web3, SYSTEM_PROGRAM_ID, false, false),
          keyOf(web3, TOKEN_2022_PROGRAM_ID, false, false),
        ],
        Uint8Array.of(1), // CreateIdempotent
      ),
      instruction(
        web3,
        TOKEN_2022_PROGRAM_ID,
        [keyOf(web3, mint, false, true), keyOf(web3, ata, false, true), keyOf(web3, payer, true, false)],
        concat(Uint8Array.of(IX.mintTo), u64le(line.amount)),
      ),
    );
  }
  out.push(
    instruction(
      web3,
      TOKEN_2022_PROGRAM_ID,
      [keyOf(web3, mint, false, true), keyOf(web3, payer, true, false)],
      Uint8Array.of(IX.setAuthority, AUTHORITY_MINT, 0), // new authority: none
    ),
  );
  return out;
}

/** A transaction with a recent blockhash and the creator as fee payer. */
export function assemble(web3: typeof Web3, instructions: Web3.TransactionInstruction[], creator: string, blockhash: string, lastValidBlockHeight: number): Web3.Transaction {
  const tx = new web3.Transaction({ feePayer: new web3.PublicKey(creator), blockhash, lastValidBlockHeight });
  tx.add(...instructions);
  return tx;
}

// ---------------------------------------------------------------- reading a transaction back

export type Decoded =
  | { kind: 'create-account'; from: string; to: string; lamports: bigint; space: bigint; owner: string }
  | { kind: 'metadata-pointer'; authority: string | null; metadataAddress: string; mint: string }
  | { kind: 'initialize-mint'; mint: string; decimals: number; mintAuthority: string; freezeAuthority: string | null }
  | { kind: 'initialize-metadata'; metadata: string; updateAuthority: string; mint: string; mintAuthority: string; name: string; symbol: string; uri: string }
  | { kind: 'create-token-account'; payer: string; ata: string; owner: string; mint: string }
  | { kind: 'mint-to'; mint: string; destination: string; authority: string; amount: bigint }
  | { kind: 'set-authority'; account: string; authorityType: number; successor: string | null }
  | { kind: 'unknown'; program: string; note: string };

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);

function readString(d: Uint8Array, at: number): { value: string; next: number } | null {
  if (at + 4 > d.length) return null;
  const len = view(d).getUint32(at, true);
  if (at + 4 + len > d.length) return null;
  return { value: new TextDecoder('utf-8', { fatal: true }).decode(d.subarray(at + 4, at + 4 + len)), next: at + 4 + len };
}

/** Decodes one instruction into what it does. Anything it does not recognise comes back as `unknown`, which the check rejects. */
export function decodeInstruction(web3: typeof Web3, ix: Web3.TransactionInstruction): Decoded {
  const program = ix.programId.toBase58();
  const d = Uint8Array.from(ix.data);
  const k = ix.keys.map((m) => m.pubkey.toBase58());
  try {
    if (program === SYSTEM_PROGRAM_ID) {
      if (d.length === 52 && view(d).getUint32(0, true) === 0 && k.length === 2)
        return { kind: 'create-account', from: k[0]!, to: k[1]!, lamports: view(d).getBigUint64(4, true), space: view(d).getBigUint64(12, true), owner: new web3.PublicKey(d.subarray(20, 52)).toBase58() };
      return { kind: 'unknown', program, note: `system instruction ${d.length >= 4 ? view(d).getUint32(0, true) : '?'}` };
    }
    if (program === ATA_PROGRAM_ID) {
      if (d.length === 1 && d[0] === 1 && k.length === 6 && k[4] === SYSTEM_PROGRAM_ID && k[5] === TOKEN_2022_PROGRAM_ID)
        return { kind: 'create-token-account', payer: k[0]!, ata: k[1]!, owner: k[2]!, mint: k[3]! };
      return { kind: 'unknown', program, note: 'associated token account instruction' };
    }
    if (program === TOKEN_2022_PROGRAM_ID) {
      if (d.length === 66 && d[0] === IX.metadataPointer && d[1] === 0 && k.length === 1) {
        const authority = d.subarray(2, 34).every((b) => b === 0) ? null : new web3.PublicKey(d.subarray(2, 34)).toBase58();
        return { kind: 'metadata-pointer', authority, metadataAddress: new web3.PublicKey(d.subarray(34, 66)).toBase58(), mint: k[0]! };
      }
      if (d[0] === IX.initializeMint && (d.length === 35 || d.length === 67) && k.length === 2 && k[1] === RENT_SYSVAR_ID) {
        const hasFreeze = d[34] === 1;
        if (d.length === (hasFreeze ? 67 : 35))
          return { kind: 'initialize-mint', mint: k[0]!, decimals: d[1]!, mintAuthority: new web3.PublicKey(d.subarray(2, 34)).toBase58(), freezeAuthority: hasFreeze ? new web3.PublicKey(d.subarray(35, 67)).toBase58() : null };
      }
      if (d.length >= 8 && eq(d.subarray(0, 8), METADATA_INITIALIZE) && k.length === 4) {
        const name = readString(d, 8);
        const symbol = name && readString(d, name.next);
        const uri = symbol && readString(d, symbol.next);
        if (name && symbol && uri && uri.next === d.length)
          return { kind: 'initialize-metadata', metadata: k[0]!, updateAuthority: k[1]!, mint: k[2]!, mintAuthority: k[3]!, name: name.value, symbol: symbol.value, uri: uri.value };
      }
      if (d[0] === IX.mintTo && d.length === 9 && k.length === 3)
        return { kind: 'mint-to', mint: k[0]!, destination: k[1]!, authority: k[2]!, amount: view(d).getBigUint64(1, true) };
      if (d[0] === IX.setAuthority && k.length === 2 && ((d.length === 3 && d[2] === 0) || (d.length === 35 && d[2] === 1)))
        return { kind: 'set-authority', account: k[0]!, authorityType: d[1]!, successor: d[2] === 1 ? new web3.PublicKey(d.subarray(3, 35)).toBase58() : null };
      return { kind: 'unknown', program, note: `token instruction ${d[0]}` };
    }
  } catch {
    return { kind: 'unknown', program, note: 'could not be read' };
  }
  return { kind: 'unknown', program, note: 'a program this page does not use' };
}

// ---------------------------------------------------------------- the check before signing

export interface CheckInput {
  config: LaunchConfig;
  mint: string;
  mintRentLamports: bigint;
}

/**
 * Reads a built transaction back and compares it with what the review screen showed. Returns the reasons not to sign; empty
 * means every instruction is one of the expected ones, with exactly the expected accounts and amounts, and the only accounts
 * that must sign are the creator and (for the first transaction) the new token.
 */
export function inspectStep(web3: typeof Web3, tx: Web3.Transaction, step: 1 | 2, input: CheckInput): string[] {
  const { config, mint, mintRentLamports } = input;
  const blockers: string[] = [];
  const payer = config.creator;
  if (tx.feePayer?.toBase58() !== payer) blockers.push('The fee would be paid by an account other than yours.');
  const signers = new Set<string>();
  for (const ix of tx.instructions) for (const m of ix.keys) if (m.isSigner) signers.add(m.pubkey.toBase58());
  const allowedSigners = new Set(step === 1 ? [payer, mint] : [payer]);
  for (const s of signers) if (!allowedSigners.has(s)) blockers.push(`An unexpected account would have to sign: ${s}.`);
  const decoded = tx.instructions.map((ix) => decodeInstruction(web3, ix));
  for (const d of decoded) if (d.kind === 'unknown') blockers.push(`An instruction this page did not expect (${d.note}).`);
  if (blockers.length > 0) return blockers;

  if (step === 1) {
    const sizes = mintSizes(config);
    const [a, b, c, e] = decoded;
    if (decoded.length !== 4 || a?.kind !== 'create-account' || b?.kind !== 'metadata-pointer' || c?.kind !== 'initialize-mint' || e?.kind !== 'initialize-metadata')
      return ['The first transaction is not the expected four steps.'];
    if (a.from !== payer || a.to !== mint) blockers.push('The new token account is not the one shown.');
    if (a.lamports !== mintRentLamports) blockers.push('The deposit for the token account is not the amount shown.');
    if (a.space !== BigInt(sizes.allocated)) blockers.push('The token account size is not the expected one.');
    if (a.owner !== TOKEN_2022_PROGRAM_ID) blockers.push('The token account would belong to an unexpected program.');
    if (b.mint !== mint || b.metadataAddress !== mint || b.authority !== null) blockers.push('The metadata link is not the expected one.');
    if (c.mint !== mint || c.decimals !== config.decimals || c.mintAuthority !== payer) blockers.push('The token settings are not the ones shown.');
    if (c.freezeAuthority !== null) blockers.push('A freeze authority would be set. Tokens made here never have one.');
    if (e.metadata !== mint || e.mint !== mint || e.mintAuthority !== payer) blockers.push('The metadata would be written to an unexpected account.');
    if (e.updateAuthority !== (config.metadataMutable ? payer : SYSTEM_PROGRAM_ID)) blockers.push('Who can change the name, symbol and link is not what was shown.');
    if (e.name !== config.name || e.symbol !== config.symbol || e.uri !== config.metadataUri) blockers.push('The name, symbol or link differ from what was shown.');
    return blockers;
  }

  const lines = distributionOf(config);
  const expected: DistributionLine[] = lines;
  const created = decoded.filter((x): x is Extract<Decoded, { kind: 'create-token-account' }> => x.kind === 'create-token-account');
  const minted = decoded.filter((x): x is Extract<Decoded, { kind: 'mint-to' }> => x.kind === 'mint-to');
  const revoked = decoded.filter((x): x is Extract<Decoded, { kind: 'set-authority' }> => x.kind === 'set-authority');
  if (decoded.length !== expected.length * 2 + 1 || created.length !== expected.length || minted.length !== expected.length || revoked.length !== 1)
    return ['The second transaction is not the expected set of steps.'];
  // Order matters: accounts and mints in pairs, then the authority is given up last.
  if (decoded[decoded.length - 1]?.kind !== 'set-authority') blockers.push('The mint authority would not be given up last.');
  let total = 0n;
  expected.forEach((line, i) => {
    const ata = ataAddress(web3, line.owner, mint, TOKEN_2022_PROGRAM_ID);
    const c = decoded[i * 2];
    const m = decoded[i * 2 + 1];
    if (c?.kind !== 'create-token-account' || m?.kind !== 'mint-to') {
      blockers.push('The steps are not in the expected order.');
      return;
    }
    if (c.payer !== payer || c.owner !== line.owner || c.mint !== mint || c.ata !== ata) blockers.push(`The token account for ${line.owner} is not the expected one.`);
    if (m.mint !== mint || m.destination !== ata || m.authority !== payer) blockers.push(`The tokens for ${line.owner} would go to an unexpected account.`);
    if (m.amount !== line.amount) blockers.push(`The amount for ${line.owner} is not the one shown.`);
    total += m.amount;
  });
  if (total !== config.totalSupplyRaw || total !== shareOf(config.totalSupplyRaw, 10_000)) blockers.push('The amounts do not add up to the supply that was shown.');
  const r = revoked[0]!;
  if (r.account !== mint || r.authorityType !== AUTHORITY_MINT || r.successor !== null) blockers.push('The mint authority would not be given up.');
  return blockers;
}
