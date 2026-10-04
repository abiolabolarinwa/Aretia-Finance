/**
 * Pure logic for the web wallet's Shield and Intent tabs (no DOM, no network), so it can be
 * tested on its own. Mirrors the Aretia Wallet extension's rules: `parseIntent` is the same
 * fixed-phrase parser (packages/intent), and `shieldFindings` the same Solana recipient check
 * (packages/chains/solana/src/shield.ts), minus anything that needs a signing wallet.
 */

import type * as Web3 from '@solana/web3.js';

// ------------------------------------------------------------------ addresses

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** True for a base58 string that decodes to exactly 32 bytes, i.e. a Solana public key. */
export function isSolanaAddress(value: string): boolean {
  if (value.length < 32 || value.length > 44) return false;
  const bytes: number[] = [];
  for (const ch of value) {
    let carry = BASE58.indexOf(ch);
    if (carry < 0) return false;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i]! * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  // Each leading '1' is one leading zero byte.
  for (const ch of value) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return bytes.length === 32;
}

// ------------------------------------------------------------------ Shield

/** The System Program id (32 zero bytes in base58), owner of every plain wallet account. */
export const SYSTEM_PROGRAM_ID = '1'.repeat(32);

export interface AccountSnapshot {
  /** False when `getAccountInfo` returned null: the address has never been funded or touched. */
  exists: boolean;
  executable: boolean;
  owner: string | null;
}

export interface Finding {
  severity: 'warning' | 'info';
  message: string;
}

export function shieldFindings(account: AccountSnapshot, ownAddress: string | null, checked: string): Finding[] {
  const findings: Finding[] = [];
  if (ownAddress !== null && ownAddress === checked) {
    findings.push({ severity: 'info', message: 'This is the address of the wallet you have connected.' });
  }
  if (!account.exists) {
    findings.push({
      severity: 'warning',
      message:
        'This address has no prior on-chain activity. Double-check it before sending, especially if you typed or pasted it.',
    });
    return findings;
  }
  if (account.executable || (account.owner !== null && account.owner !== SYSTEM_PROGRAM_ID)) {
    findings.push({
      severity: 'info',
      message: 'This is a program or token account, not a personal wallet. Sending to it may not reach a person.',
    });
  }
  return findings;
}

// ------------------------------------------------------------------ Intent

export type ParsedIntent =
  | { kind: 'send'; amount: string; assetSymbol: string; recipient: string }
  | { kind: 'swap'; amount: string; fromAssetSymbol: string; toAssetSymbol: string };

const AMOUNT = String.raw`\d+(?:\.\d+)?`;
const SYMBOL = String.raw`[A-Za-z][A-Za-z0-9]*`;
const RECIPIENT = String.raw`\S+?`;
const SWAP_RE = new RegExp(`^swap\\s+(${AMOUNT})\\s+(${SYMBOL})\\s+(?:for|to)\\s+(${SYMBOL})[.!?]?$`, 'i');
const SEND_RE = new RegExp(`^(?:send|pay)\\s+(${AMOUNT})\\s+(${SYMBOL})\\s+to\\s+(${RECIPIENT})[.!?]?$`, 'i');
const PAY_RE = new RegExp(`^pay\\s+(${RECIPIENT})\\s+(${AMOUNT})\\s+(${SYMBOL})[.!?]?$`, 'i');
const stripPunctuation = (v: string) => v.replace(/[.!?,]+$/, '');

/** A fixed set of phrasings, never a guess: anything else returns null. */
export function parseIntent(text: string): ParsedIntent | null {
  const t = text.trim();
  if (!t) return null;
  const swap = t.match(SWAP_RE);
  if (swap) return { kind: 'swap', amount: swap[1]!, fromAssetSymbol: swap[2]!.toUpperCase(), toAssetSymbol: swap[3]!.toUpperCase() };
  const send = t.match(SEND_RE);
  if (send) return { kind: 'send', amount: send[1]!, assetSymbol: send[2]!.toUpperCase(), recipient: stripPunctuation(send[3]!) };
  const pay = t.match(PAY_RE);
  if (pay) return { kind: 'send', amount: pay[2]!, assetSymbol: pay[3]!.toUpperCase(), recipient: stripPunctuation(pay[1]!) };
  return null;
}

export interface Candidate {
  mint: string;
  symbol: string;
  /** True for tokens the wallet holds. */
  held: boolean;
  amount: number | null;
  /** Decimal places of the token, or null when unknown. */
  decimals: number | null;
}

/** Tokens Intent can swap into even when the wallet holds none: real mints, never matched by name alone. */
export const KNOWN_TOKENS: ReadonlyArray<{ symbol: string; mint: string; decimals: number }> = [
  { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
  { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
  { symbol: 'ACT', mint: '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG', decimals: 9 },
];

export interface HeldToken {
  mint: string;
  symbol: string;
  amount: number;
  decimals: number | null;
}

/** Everything a symbol could mean: held tokens with that symbol, plus the one real mint for a known symbol. */
export function candidatesFor(symbol: string, holdings: readonly HeldToken[], includeKnown: boolean): Candidate[] {
  const upper = symbol.toUpperCase();
  const out: Candidate[] = holdings
    .filter((h) => h.symbol.toUpperCase() === upper)
    .map((h) => ({ mint: h.mint, symbol: h.symbol, held: true, amount: h.amount, decimals: h.decimals }));
  if (includeKnown) {
    for (const k of KNOWN_TOKENS) {
      if (k.symbol === upper && !out.some((c) => c.mint === k.mint)) out.push({ mint: k.mint, symbol: k.symbol, held: false, amount: null, decimals: k.decimals });
    }
  }
  return out;
}

/**
 * "0.001" -> "1000000" for a 9-decimal token, by string arithmetic (no floating point).
 * Returns null when the text is not a plain decimal number or has more decimal places than the token.
 */
export function toSmallestUnit(amount: string, decimals: number): string | null {
  const m = amount.match(/^(\d+)(?:\.(\d+))?$/);
  if (!m) return null;
  const fraction = m[2] ?? '';
  if (fraction.length > decimals) return null;
  const digits = (m[1]! + fraction.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
  return digits;
}

// ------------------------------------------------------------------ Send (pure parts)


export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
/** Lamports needed to keep a brand-new 0-byte account alive (rent exemption). */
export const MIN_NEW_ACCOUNT_LAMPORTS = 890_880n;
/** Base network fee for a one-signature transaction. */
export const BASE_FEE_LAMPORTS = 5_000n;

/** "1000000" -> "0.001" for a 9-decimal token: the inverse of `toSmallestUnit`. */
export function fromSmallestUnit(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const digits = (negative ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export interface MintInfo {
  decimals: number;
  /** Token-2022 mints with extensions (such as a transfer fee) are longer than the 82-byte base layout. */
  hasExtensions: boolean;
}

/** Reads the decimals from a mint account's data; null if it is too short to be a mint. */
export function parseMint(owner: string, data: Uint8Array): MintInfo | null {
  if (owner !== TOKEN_PROGRAM_ID && owner !== TOKEN_2022_PROGRAM_ID) return null;
  if (data.length < 82 || data[45] !== 1) return null; // byte 45 is is_initialized
  return { decimals: data[44]!, hasExtensions: owner === TOKEN_2022_PROGRAM_ID && data.length > 82 };
}

export interface TokenAccountInfo {
  amount: bigint;
  frozen: boolean;
}

/** Reads balance and frozen state from a token account's data; null if too short or uninitialised. */
export function parseTokenAccount(data: Uint8Array): TokenAccountInfo | null {
  if (data.length < 165) return null;
  const state = data[108]!;
  if (state === 0) return null;
  return { amount: new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true), frozen: state === 2 };
}

/** The associated token account address for an owner, mint and token program. */
export function ataAddress(web3: typeof Web3, owner: string, mint: string, tokenProgram: string): string {
  const [address] = web3.PublicKey.findProgramAddressSync(
    [new web3.PublicKey(owner).toBytes(), new web3.PublicKey(tokenProgram).toBytes(), new web3.PublicKey(mint).toBytes()],
    new web3.PublicKey(ATA_PROGRAM_ID),
  );
  return address.toBase58();
}

function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/** A plain SOL transfer. */
export function solTransferInstruction(web3: typeof Web3, from: string, to: string, lamports: bigint): Web3.TransactionInstruction {
  return web3.SystemProgram.transfer({ fromPubkey: new web3.PublicKey(from), toPubkey: new web3.PublicKey(to), lamports });
}

/** Create the recipient's associated token account if it does not exist yet (safe to include if it does). */
export function createAtaIdempotentInstruction(web3: typeof Web3, payer: string, ata: string, owner: string, mint: string, tokenProgram: string): Web3.TransactionInstruction {
  const key = (address: string, isSigner: boolean, isWritable: boolean) => ({ pubkey: new web3.PublicKey(address), isSigner, isWritable });
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(ATA_PROGRAM_ID),
    keys: [
      key(payer, true, true),
      key(ata, false, true),
      key(owner, false, false),
      key(mint, false, false),
      key('11111111111111111111111111111111', false, false),
      key(tokenProgram, false, false),
    ],
    data: new Uint8Array([1]) as unknown as Buffer,
  });
}

/** SPL Token / Token-2022 `TransferChecked`: the program re-checks the mint and decimals, and applies any transfer fee itself. */
export function transferCheckedInstruction(web3: typeof Web3, tokenProgram: string, source: string, mint: string, destination: string, owner: string, amount: bigint, decimals: number): Web3.TransactionInstruction {
  const key = (address: string, isSigner: boolean, isWritable: boolean) => ({ pubkey: new web3.PublicKey(address), isSigner, isWritable });
  const data = new Uint8Array(10);
  data[0] = 12;
  data.set(u64le(amount), 1);
  data[9] = decimals;
  return new web3.TransactionInstruction({
    programId: new web3.PublicKey(tokenProgram),
    keys: [key(source, false, true), key(mint, false, false), key(destination, false, true), key(owner, true, false)],
    data: data as unknown as Buffer,
  });
}

export interface RecipientVerdict {
  /** Reasons the transfer must not go ahead. */
  blockers: string[];
  /** The recipient is owned by an unusual program: the user must acknowledge before signing. */
  needsAck: boolean;
}

/**
 * Whether it is safe to send to this account. A program or a token account cannot be an owner of a
 * token account the way a wallet can, so tokens sent to it would be stuck for good.
 */
export function judgeRecipient(account: AccountSnapshot): RecipientVerdict {
  const blockers: string[] = [];
  let needsAck = false;
  if (account.exists) {
    if (account.executable) blockers.push('This address is a program, not a wallet. Funds sent to it would be stuck.');
    else if (account.owner === TOKEN_PROGRAM_ID || account.owner === TOKEN_2022_PROGRAM_ID) {
      blockers.push('This address is a token account, not a wallet. Send to the wallet that owns it instead.');
    } else if (account.owner !== null && account.owner !== SYSTEM_PROGRAM_ID) {
      needsAck = true;
    }
  }
  return { blockers, needsAck };
}
