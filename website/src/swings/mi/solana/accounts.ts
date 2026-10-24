/**
 * Solana account helpers that need no Solana library (the library does not load inside the site's server functions):
 * base58, program-derived addresses, and the layouts of an SPL mint, a token account, a Metaplex metadata account and an
 * Orca Whirlpool. Every parser returns null for data that does not have the expected size or tag, never a guess.
 */
import { createHash } from 'node:crypto';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)]! + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function decodeBase58(s: string): Uint8Array | null {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

/** A base58 string that decodes to exactly 32 bytes: a Solana public key. */
export const isSolanaAddress = (s: unknown): s is string => typeof s === 'string' && s.length >= 32 && s.length <= 44 && decodeBase58(s)?.length === 32;

// ---- ed25519 curve membership: a program-derived address must NOT be a valid curve point.
const P = (1n << 255n) - 19n;
const D = (-121665n * modInv(121666n, P)) % P;
function modPow(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}
function modInv(a: bigint, m: bigint): bigint {
  return modPow(((a % m) + m) % m, m - 2n, m);
}
/** True when the 32 bytes decode to a point on the ed25519 curve (RFC 8032 point decompression succeeds). */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]!);
  y &= (1n << 255n) - 1n;
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const x2 = (u * modInv(v, P)) % P;
  if (x2 === 0n) return (bytes[31]! & 0x80) === 0;
  return modPow(x2, (P - 1n) / 2n, P) === 1n;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The program-derived address for `seeds` under `program`, with its bump, exactly as Solana derives it. */
export function findProgramAddress(seeds: readonly Uint8Array[], program: string): { address: string; bump: number } | null {
  const programBytes = decodeBase58(program);
  if (programBytes?.length !== 32) return null;
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(programBytes);
    h.update(utf8('ProgramDerivedAddress'));
    const candidate = new Uint8Array(h.digest());
    if (!isOnCurve(candidate)) return { address: encodeBase58(candidate), bump };
  }
  return null;
}

export const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Where a mint's Metaplex metadata account lives. */
export function metadataAddress(mint: string): string | null {
  const m = decodeBase58(mint);
  const p = decodeBase58(METADATA_PROGRAM);
  if (m?.length !== 32 || !p) return null;
  return findProgramAddress([utf8('metadata'), p, m], METADATA_PROGRAM)?.address ?? null;
}

const view = (d: Uint8Array): DataView => new DataView(d.buffer, d.byteOffset, d.byteLength);
export const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const keyAt = (d: Uint8Array, o: number): string => encodeBase58(d.subarray(o, o + 32));
const NUL = new RegExp(String.fromCharCode(0), 'g');

export interface MintInfo {
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

/** SPL mint (82 bytes; Token-2022 mints are longer and begin the same way). */
export function parseMint(d: Uint8Array): MintInfo | null {
  if (d.length < 82) return null;
  const v = view(d);
  const decimals = d[44]!;
  if (decimals > 36 || d[45] !== 1) return null; // is_initialized
  return { decimals, supply: v.getBigUint64(36, true), mintAuthority: v.getUint32(0, true) === 1 ? keyAt(d, 4) : null, freezeAuthority: v.getUint32(46, true) === 1 ? keyAt(d, 50) : null };
}

/** The amount held by an SPL token account. */
export function tokenAmount(d: Uint8Array): bigint | null {
  return d.length >= 72 ? view(d).getBigUint64(64, true) : null;
}

export interface MetadataInfo {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
}

function readString(d: Uint8Array, offset: number, max: number): { text: string; next: number } | null {
  if (offset + 4 > d.length) return null;
  const len = view(d).getUint32(offset, true);
  if (len > max || offset + 4 + len > d.length) return null;
  return { text: new TextDecoder().decode(d.subarray(offset + 4, offset + 4 + len)).replace(NUL, '').trim(), next: offset + 4 + len };
}

/** Metaplex metadata account: key (4 = MetadataV1), update authority, mint, then name, symbol and uri. */
export function parseMetadata(d: Uint8Array): MetadataInfo | null {
  if (d.length < 1 + 32 + 32 + 12 || d[0] !== 4) return null;
  const mint = keyAt(d, 33);
  const name = readString(d, 65, 64);
  if (!name) return null;
  const symbol = readString(d, name.next, 32);
  if (!symbol) return null;
  const uri = readString(d, symbol.next, 400);
  if (!uri) return null;
  return { mint, name: name.text, symbol: symbol.text, uri: uri.text };
}

export interface WhirlpoolInfo {
  tickSpacing: number;
  feeRate: number;
  sqrtPrice: bigint;
  mintA: string;
  vaultA: string;
  mintB: string;
  vaultB: string;
}

export function parseWhirlpool(d: Uint8Array): WhirlpoolInfo | null {
  if (d.length < 269) return null;
  const v = view(d);
  return { tickSpacing: v.getUint16(41, true), feeRate: v.getUint16(45, true), sqrtPrice: v.getBigUint64(65, true) + (v.getBigUint64(73, true) << 64n), mintA: keyAt(d, 101), vaultA: keyAt(d, 133), mintB: keyAt(d, 181), vaultB: keyAt(d, 213) };
}

/** Price of token A in token B (whole tokens), x 10^PRICE_SCALE, from a Whirlpool's sqrt price (Q64.64). */
export function whirlpoolPriceScaled(sqrtPrice: bigint, decimalsA: number, decimalsB: number, scale = 30): bigint | null {
  if (sqrtPrice <= 0n) return null;
  const num = sqrtPrice * sqrtPrice * 10n ** BigInt(decimalsA) * 10n ** BigInt(scale);
  const den = (1n << 128n) * 10n ** BigInt(decimalsB);
  return (num * 2n + den) / (den * 2n);
}

/**
 * Token-2022 keeps a token's name inside the mint itself, in a TLV extension: account type byte at 165 (1 = mint), then entries of
 * (type u16, length u16, value). Type 19 is TokenMetadata: update authority, mint, then name, symbol and uri as length-prefixed strings.
 */
export function parseToken2022Metadata(d: Uint8Array): MetadataInfo | null {
  if (d.length <= 166 || d[165] !== 1) return null;
  const v = view(d);
  let o = 166;
  while (o + 4 <= d.length) {
    const type = v.getUint16(o, true);
    const len = v.getUint16(o + 2, true);
    o += 4;
    if (o + len > d.length) return null;
    if (type === 19 && len >= 68) {
      const base = o + 64;
      const name = readString(d.subarray(0, o + len), base, 64);
      if (!name) return null;
      const symbol = readString(d.subarray(0, o + len), name.next, 32);
      if (!symbol) return null;
      const uri = readString(d.subarray(0, o + len), symbol.next, 400);
      return { mint: keyAt(d, o + 32), name: name.text, symbol: symbol.text, uri: uri?.text ?? '' };
    }
    o += len;
  }
  return null;
}
