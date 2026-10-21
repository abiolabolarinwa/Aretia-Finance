/**
 * Token-2022 mint accounts, read from their raw bytes: which extensions a mint carries, what each one means for a holder,
 * and the exact rule Aretia's on-chain programs apply before they accept a mint (`check_mint` in
 * program/aretia-curve/programs/aretia-curve/src/lib.rs). Pure: no network, no web3 library, so the server (the Launch Box
 * indexer, the risk engine) and the page share one reading.
 */

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Token-2022's ExtensionType enum (spl-token-2022 `extension/mod.rs`). */
export const EXTENSION_NAMES: Readonly<Record<number, string>> = {
  0: 'Uninitialized',
  1: 'Transfer fee',
  2: 'Transfer fee amount',
  3: 'Mint close authority',
  4: 'Confidential transfers',
  5: 'Confidential transfer account',
  6: 'Default account state',
  7: 'Immutable owner',
  8: 'Memo transfer',
  9: 'Non-transferable',
  10: 'Interest-bearing',
  11: 'CPI guard',
  12: 'Permanent delegate',
  13: 'Non-transferable account',
  14: 'Transfer hook',
  15: 'Transfer hook account',
  16: 'Confidential transfer fee',
  17: 'Confidential transfer fee amount',
  18: 'Metadata pointer',
  19: 'Token metadata',
  20: 'Group pointer',
  21: 'Token group',
  22: 'Group member pointer',
  23: 'Token group member',
  24: 'Confidential mint and burn',
  25: 'Scaled UI amount',
  26: 'Pausable',
  27: 'Pausable account',
};

export type ExtensionClass = 'bad' | 'warn' | 'neutral';

/** Extensions that only describe the token (name, symbol, link, collection). */
const NEUTRAL = new Set([18, 19, 20, 21, 22, 23]);
/** Extensions that change what a holder sees or can verify, without handing anyone their tokens. */
const WARN = new Set([4, 10, 16, 24, 25]);

/** What a holder should make of an extension. Anything not known to be harmless or merely confusing is "bad", including types this code does not know. */
export const extensionClass = (type: number): ExtensionClass => (NEUTRAL.has(type) ? 'neutral' : WARN.has(type) ? 'warn' : 'bad');

/** Plain words for each extension that matters to a holder. */
export const EXTENSION_MEANING: Readonly<Record<number, string>> = {
  1: 'a fee is taken on every transfer, and its owner can raise it',
  3: 'the mint can be closed and re-created with different rules',
  4: 'balances can be moved in hidden (confidential) form',
  6: 'new holder accounts can start frozen',
  9: 'the token cannot be transferred, so it cannot be sold',
  10: 'the displayed balance grows or shrinks by an interest rate the issuer sets',
  12: 'a permanent delegate can move or burn any holder’s tokens',
  14: 'a program the issuer chose runs on every transfer and can block sells',
  16: 'transfer fees can be held in hidden (confidential) form',
  24: 'tokens can be minted and burned in hidden (confidential) form',
  25: 'the displayed balance is multiplied by a factor the issuer can change',
  26: 'the issuer can pause every transfer',
};

export const extensionLabel = (type: number): string => `${EXTENSION_NAMES[type] ?? 'Unknown extension'} (${type})`;

// ---------------------------------------------------------------- what is inside the extensions that hand someone a power

/**
 * The authority fields of the extensions whose danger depends on who (if anyone) still holds them, read with the spl-token-2022
 * layouts. An OptionalNonZeroPubkey is 32 bytes and all zeros means "none" (null here). An entry whose length is not the layout's is
 * left out, so the extension is judged by its type alone (as dangerous).
 */
export interface ExtensionDetails {
  /** TransferFeeConfig (1): 32 config authority, 32 withdraw-withheld authority, u64 withheld, then the older and newer TransferFee (u64 epoch, u64 maximum fee, u16 basis points). */
  transferFee?: { configAuthority: string | null; withdrawAuthority: string | null; olderBps: number; newerBps: number; newerEpoch: bigint; maximumFee: bigint };
  /** PermanentDelegate (12): 32 delegate. */
  permanentDelegate?: { delegate: string | null };
  /** TransferHook (14): 32 authority, 32 program id. */
  transferHook?: { authority: string | null; programId: string | null };
  /** PausableConfig (26): 32 authority, 1 paused flag. */
  pausable?: { authority: string | null; paused: boolean };
}

const optionalKey = (b: Uint8Array): string | null => (b.every((x) => x === 0) ? null : base58(b));

/** The details above from a mint's bytes ({} when there are none or the bytes are not a Token-2022 mint with extensions). */
export function readExtensionDetails(data: Uint8Array): ExtensionDetails {
  const out: ExtensionDetails = {};
  if (data.length < 166 || data[45] !== 1 || data[165] !== 1) return out;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = 166; at + 4 <= data.length; ) {
    const type = v.getUint16(at, true);
    const len = v.getUint16(at + 2, true);
    const start = at + 4;
    if (type === 0 || start + len > data.length) break;
    const key = (off: number): string | null => optionalKey(data.subarray(start + off, start + off + 32));
    if (type === 1 && len === 108) {
      out.transferFee = { configAuthority: key(0), withdrawAuthority: key(32), olderBps: v.getUint16(start + 72 + 16, true), newerEpoch: v.getBigUint64(start + 90, true), maximumFee: v.getBigUint64(start + 90 + 8, true), newerBps: v.getUint16(start + 90 + 16, true) };
    } else if (type === 12 && len === 32) out.permanentDelegate = { delegate: key(0) };
    else if (type === 14 && len === 64) out.transferHook = { authority: key(0), programId: key(32) };
    else if (type === 26 && len === 33) out.pausable = { authority: key(0), paused: data[start + 32] !== 0 };
    at = start + len;
  }
  return out;
}

/** Addresses Aretia can name in a warning instead of showing a bare key. */
export const KNOWN_AUTHORITIES: Readonly<Record<string, string>> = {
  GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA: 'the Aretia treasury multisig (2 of 3)',
};
const who = (key: string): string => KNOWN_AUTHORITIES[key] ?? `${key.slice(0, 4)}…${key.slice(-4)}`;
const pct = (bps: number): string => `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

/** A transfer fee above this (in basis points) is rated "bad", as an EVM sell tax over 10% is; at or below it, a warning. */
export const TRANSFER_FEE_BAD_BPS = 1_000;
/** A transfer fee at or above this takes most of every transfer: the token is rated "restricted", like a 50% EVM tax. */
export const TRANSFER_FEE_TRAP_BPS = 5_000;

export interface ExtensionVerdict {
  type: number;
  class: ExtensionClass;
  /** Lets someone take, block or stop holders' tokens outright: the token is rated "restricted". */
  trap: boolean;
  /** Plain words for a holder; empty for the name and metadata extensions. */
  meaning: string;
}

/** Extensions that are a trap whenever they are present and their power has not been shown to be given up. */
const TRAP_TYPES = new Set([9, 12, 14, 26]);

/**
 * What each extension means for a holder, using the authorities inside it when they were read (`details`). A power that is given
 * up is no longer held against anyone: a permanent delegate or transfer hook with no one behind it is neutral, a transfer hook with
 * no program but a live authority is a warning, a pause switch nobody holds is neutral unless transfers are paused right now. A
 * transfer fee is rated by its rate (the higher of the current and the scheduled one, since the epoch is not read here) and names
 * who can change it. Anything this code cannot read keeps the type's own rating.
 */
export function judgeExtensions(types: readonly number[], details: ExtensionDetails = {}): ExtensionVerdict[] {
  return types.map((type): ExtensionVerdict => {
    const fallback: ExtensionVerdict = { type, class: extensionClass(type), trap: TRAP_TYPES.has(type), meaning: EXTENSION_MEANING[type] ?? '' };
    if (type === 1 && details.transferFee) {
      const f = details.transferFee;
      const bps = Math.max(f.olderBps, f.newerBps);
      const rate = f.olderBps === f.newerBps ? `a ${pct(bps)} fee is taken on every transfer` : `a fee of ${pct(f.olderBps)} is taken on every transfer, set to become ${pct(f.newerBps)} from epoch ${f.newerEpoch}`;
      const control = f.configAuthority ? `${who(f.configAuthority)} can change the rate (a change takes effect only from a later epoch, never at once)` : 'no one can change the rate';
      const collect = f.withdrawAuthority ? `; the fees go to ${who(f.withdrawAuthority)}` : '';
      if (bps === 0 && !f.configAuthority) return { type, class: 'neutral', trap: false, meaning: 'no transfer fee, and no one can set one' };
      return { type, class: bps > TRANSFER_FEE_BAD_BPS ? 'bad' : 'warn', trap: bps >= TRANSFER_FEE_TRAP_BPS, meaning: `${bps === 0 ? 'no fee is taken now' : rate}; ${control}${collect}` };
    }
    if (type === 12 && details.permanentDelegate) {
      const d = details.permanentDelegate.delegate;
      return d ? { ...fallback, meaning: `a permanent delegate (${who(d)}) can move or burn any holder’s tokens` } : { type, class: 'neutral', trap: false, meaning: 'the permanent delegate is given up: no one can move holders’ tokens' };
    }
    if (type === 14 && details.transferHook) {
      const { authority, programId } = details.transferHook;
      if (programId) return { ...fallback, meaning: `a program (${who(programId)}) runs on every transfer and can block sells${authority ? `; ${who(authority)} can change it` : ''}` };
      return authority ? { type, class: 'warn', trap: false, meaning: `no transfer program is set now, but ${who(authority)} can set one that runs on every transfer` } : { type, class: 'neutral', trap: false, meaning: 'no transfer program is set, and no one can set one' };
    }
    if (type === 26 && details.pausable) {
      const { authority, paused } = details.pausable;
      if (paused) return { ...fallback, meaning: `transfers are paused right now${authority ? ` by ${who(authority)}` : ', and no one can resume them'}` };
      return authority ? { ...fallback, meaning: `${who(authority)} can pause every transfer` } : { type, class: 'neutral', trap: false, meaning: 'the pause switch is given up: no one can pause transfers' };
    }
    return fallback;
  });
}

/**
 * The extension types written in a Token-2022 mint, in order. Null when the bytes are not a well-formed mint
 * (an SPL Token mint of exactly 82 bytes has none and gives []).
 */
export function mintExtensionTypes(data: Uint8Array): number[] | null {
  if (data.length < 82 || data[45] !== 1) return null;
  if (data.length === 82) return [];
  if (data.length < 166 || data[165] !== 1) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const out: number[] = [];
  let at = 166;
  while (at + 4 <= data.length) {
    const type = v.getUint16(at, true);
    const len = v.getUint16(at + 2, true);
    if (type === 0) break;
    if (at + 4 + len > data.length) return null;
    out.push(type);
    at += 4 + len;
  }
  return out;
}

// ---------------------------------------------------------------- base58 (32-byte keys)

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)]! + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = '1' + s;
  }
  return s;
}

/** A base58 string as exactly 32 bytes, or null. */
export function base58To32(text: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return null;
  let n = 0n;
  for (const c of text) n = n * 58n + BigInt(B58.indexOf(c));
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }
  if (n !== 0n) return null;
  return base58(out) === text ? out : null;
}

// ---------------------------------------------------------------- the on-chain rule

export interface RawMint {
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  extensions: number[];
  /** From the TokenMetadata extension, when present and well formed. */
  name: string | null;
  symbol: string | null;
}

const decoder = new TextDecoder('utf-8', { fatal: false });

/** Reads a mint (either token program) from its bytes. Null when the bytes are not an initialised, well-formed mint. */
export function readRawMint(data: Uint8Array): RawMint | null {
  const extensions = mintExtensionTypes(data);
  if (extensions === null) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const option = (at: number): string | null | undefined => {
    const tag = v.getUint32(at, true);
    return tag === 0 ? null : tag === 1 ? base58(data.subarray(at + 4, at + 36)) : undefined;
  };
  const mintAuthority = option(0);
  const freezeAuthority = option(46);
  if (mintAuthority === undefined || freezeAuthority === undefined) return null;
  let name: string | null = null;
  let symbol: string | null = null;
  let at = 166;
  while (data.length > 82 && at + 4 <= data.length) {
    const type = v.getUint16(at, true);
    const len = v.getUint16(at + 2, true);
    if (type === 0) break;
    if (type === 19) {
      const end = at + 4 + len;
      const str = (from: number): { value: string; next: number } | null => {
        if (from + 4 > end) return null;
        const n = v.getUint32(from, true);
        return from + 4 + n > end ? null : { value: decoder.decode(data.subarray(from + 4, from + 4 + n)), next: from + 4 + n };
      };
      const n = str(at + 4 + 64);
      const s = n && str(n.next);
      if (n && s) {
        name = n.value;
        symbol = s.value;
      }
    }
    at += 4 + len;
  }
  return { decimals: data[44]!, supply: v.getBigUint64(36, true), mintAuthority, freezeAuthority, extensions, name, symbol };
}

/** The extensions Aretia's programs accept: the metadata pointer and the metadata itself. */
export const PROGRAM_ALLOWED_EXTENSIONS: readonly number[] = [18, 19];

/**
 * Why a mint fails Aretia's on-chain rule (`check_mint`), or [] when it passes: owned by Token-2022, initialised, no mint
 * authority, no freeze authority, and either exactly 82 bytes or a mint account type followed only by extensions 18 and 19,
 * ending exactly at the end of the data (or in zero padding).
 *
 * `pendingCreator`: a creation is two transactions, and the first leaves the creator as mint authority with nothing minted.
 * With this set, a mint with zero supply whose mint authority is exactly that creator is not refused for its authority.
 */
export function mintRuleProblems(owner: string, data: Uint8Array, pendingCreator: string | null = null): string[] {
  if (owner !== TOKEN_2022_PROGRAM) return ['not a Token-2022 mint'];
  if (data.length < 82 || data[45] !== 1) return ['not an initialised mint'];
  const out: string[] = [];
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const supply = v.getBigUint64(36, true);
  if (v.getUint32(0, true) !== 0) {
    const pending = pendingCreator !== null && supply === 0n && v.getUint32(0, true) === 1 && base58(data.subarray(4, 36)) === pendingCreator;
    if (!pending) out.push('a mint authority is still set');
  }
  if (v.getUint32(46, true) !== 0) out.push('a freeze authority is set');
  if (data.length === 82) return out;
  if (data.length < 166 || data[165] !== 1) return [...out, 'not a mint account'];
  let at = 166;
  while (at + 4 <= data.length) {
    const type = v.getUint16(at, true);
    const len = v.getUint16(at + 2, true);
    if (type === 0) {
      if (!data.subarray(at).every((b) => b === 0)) out.push('data after the extensions');
      return out;
    }
    if (!PROGRAM_ALLOWED_EXTENSIONS.includes(type)) out.push(`extension ${extensionLabel(type)} is not allowed`);
    at += 4 + len;
  }
  if (at !== data.length) out.push('the extensions do not end at the end of the data');
  return out;
}
