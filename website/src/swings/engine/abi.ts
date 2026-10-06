/**
 * Minimal ABI encoding for the calls Swings makes. Written out (rather than pulling in a library) so every
 * byte of a transaction Aretia builds can be read and tested here. Function selectors are computed from the
 * signature with keccak-256, never typed in by hand.
 */
import { keccak256 } from '../core/keccak.js';
import { SwingsError } from '../core/types.js';

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

export function selector(signature: string): string {
  return hex(keccak256(new TextEncoder().encode(signature)).slice(0, 4));
}

export type AbiArg = { t: 'uint'; v: bigint } | { t: 'address'; v: string } | { t: 'address[]'; v: string[] } | { t: 'bytes'; v: string } | { t: 'bytes[]'; v: string[] };

export const uint = (v: bigint): AbiArg => ({ t: 'uint', v });
export const address = (v: string): AbiArg => ({ t: 'address', v });
export const addressArray = (v: string[]): AbiArg => ({ t: 'address[]', v });
/** `v` is hex, with or without 0x. */
export const bytes = (v: string): AbiArg => ({ t: 'bytes', v });
export const bytesArray = (v: string[]): AbiArg => ({ t: 'bytes[]', v });

export const word = (h: string): string => h.padStart(64, "0");
const clean = (h: string): string => h.replace(/^0x/, '').toLowerCase();

function encodeWord(a: AbiArg): string {
  if (a.t === 'uint') {
    if (a.v < 0n || a.v >= 1n << 256n) throw new SwingsError('invalid', 'Number out of range for uint256.');
    return word(a.v.toString(16));
  }
  if (a.t === 'address') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a.v)) throw new SwingsError('invalid', 'Invalid address.');
    return word(a.v.slice(2).toLowerCase());
  }
  throw new SwingsError('invalid', 'Not a static type.');
}

/** ABI encoding of one `bytes` value: length word, then the data padded to a whole word. */
export function encodeBytes(h: string): string {
  const d = clean(h);
  if (!/^([0-9a-f]{2})*$/.test(d)) throw new SwingsError('invalid', 'Invalid hex bytes.');
  return word((d.length / 2).toString(16)) + d.padEnd(Math.ceil(d.length / 64) * 64, '0');
}

/** The tail (dynamic part) for a dynamic argument. */
function encodeDynamic(a: AbiArg): string {
  if (a.t === 'address[]') return word(a.v.length.toString(16)) + a.v.map((x) => encodeWord(address(x))).join('');
  if (a.t === 'bytes') return encodeBytes(a.v);
  if (a.t === 'bytes[]') {
    // Offsets are measured from the start of the element area, which follows the count word.
    const items = a.v.map(encodeBytes);
    let offset = items.length * 32;
    const heads = items.map((it) => {
      const h = word(offset.toString(16));
      offset += it.length / 2;
      return h;
    });
    return word(items.length.toString(16)) + heads.join('') + items.join('');
  }
  throw new SwingsError('invalid', 'Not a dynamic type.');
}

const isDynamic = (a: AbiArg): boolean => a.t === 'address[]' || a.t === 'bytes' || a.t === 'bytes[]';

/** `0x` + selector + head (static values and offsets) + tail (dynamic values). A static tuple is passed as its flat members. */
export function encodeCall(signature: string, args: AbiArg[]): string {
  const headSize = args.length * 32;
  let head = '';
  let tail = '';
  for (const a of args) {
    if (isDynamic(a)) {
      head += word((headSize + tail.length / 2).toString(16));
      tail += encodeDynamic(a);
    } else head += encodeWord(a);
  }
  return '0x' + selector(signature) + head + tail;
}

/** Splits return data into 32-byte words. */
export function words(data: string): string[] {
  const body = data.replace(/^0x/, '');
  if (body.length % 64 !== 0) throw new SwingsError('invalid', 'Malformed return data.');
  const out: string[] = [];
  for (let i = 0; i < body.length; i += 64) out.push(body.slice(i, i + 64));
  return out;
}

export const wordToBigInt = (w: string): bigint => BigInt('0x' + w);
export const wordToAddress = (w: string): string => '0x' + w.slice(24).toLowerCase();

/** Decodes a uint256[] return value (offset, length, items), as returned by `getAmountsOut`. */
export function decodeUintArray(data: string): bigint[] {
  const w = words(data);
  const offset = Number(wordToBigInt(w[0] ?? '0')) / 32;
  const length = Number(wordToBigInt(w[offset] ?? '0'));
  if (!Number.isInteger(offset) || length > 64 || offset + 1 + length > w.length) throw new SwingsError('invalid', 'Malformed array.');
  return w.slice(offset + 1, offset + 1 + length).map(wordToBigInt);
}

/** Decodes the address[] and the static words of a V2 router swap call, for display and tests. */
export function decodeAddressArrayCall(data: string, staticCount: number, arrayIndex: number): { statics: (bigint | string)[]; path: string[] } {
  const body = data.replace(/^0x/, '').slice(8);
  const w = words('0x' + body);
  const offset = Number(wordToBigInt(w[arrayIndex]!)) / 32;
  const length = Number(wordToBigInt(w[offset]!));
  const path = w.slice(offset + 1, offset + 1 + length).map(wordToAddress);
  const statics: (bigint | string)[] = [];
  for (let i = 0; i < staticCount; i++) statics.push(i === arrayIndex ? '' : wordToBigInt(w[i]!));
  return { statics, path };
}
