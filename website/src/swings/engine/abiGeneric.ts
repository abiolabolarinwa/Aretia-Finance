/**
 * A general Solidity ABI encoder and decoder (static and dynamic types, arrays, nested tuples), written out so
 * every byte of a transaction Aretia builds can be read here. It follows the contract ABI specification and is
 * tested against the specification's own worked examples (see abiGeneric.test.ts).
 *
 * Types are given as the usual strings: `uint256`, `address`, `bool`, `bytes32`, `bytes`, `string`,
 * `uint256[]`, `address[2]`, and tuples `(address,uint256,bytes)`. Values: bigint or number for integers,
 * 0x-hex strings for addresses and bytes, booleans, and arrays for arrays and tuples.
 */
import { SwingsError } from '../core/types.js';
import { selector } from './abi.js';

const hexOf = (n: bigint): string => n.toString(16).padStart(64, '0');
const bad = (message: string): never => {
  throw new SwingsError('invalid', message);
};

/** Splits "a,(b,c),d[]" at top-level commas. */
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

interface ArrayType {
  base: string;
  /** null for `T[]`, a number for `T[k]`. */
  length: number | null;
}

function arrayOf(type: string): ArrayType | null {
  const m = /^(.*)\[(\d*)\]$/.exec(type);
  return m ? { base: m[1]!, length: m[2] === '' ? null : Number(m[2]) } : null;
}

const tupleMembers = (type: string): string[] | null => (type.startsWith('(') && type.endsWith(')') ? splitTop(type.slice(1, -1)) : null);

export function isDynamicType(type: string): boolean {
  if (type === 'bytes' || type === 'string') return true;
  const arr = arrayOf(type);
  if (arr) return arr.length === null || isDynamicType(arr.base);
  const members = tupleMembers(type);
  return members !== null && members.some(isDynamicType);
}

function encodeInt(type: string, value: unknown): string {
  const signed = type.startsWith('int');
  const bits = Number(type.replace(/^u?int/, '') || '256');
  if (typeof value !== 'bigint' && typeof value !== 'number') return bad(`${type} needs a number.`);
  const v = BigInt(value);
  const limit = 1n << BigInt(signed ? bits - 1 : bits);
  if (signed ? v < -limit || v >= limit : v < 0n || v >= limit) return bad(`${v} does not fit ${type}.`);
  return hexOf(v < 0n ? (1n << 256n) + v : v);
}

function encodeStatic(type: string, value: unknown): string {
  if (/^u?int\d*$/.test(type)) return encodeInt(type, value);
  if (type === 'address') {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) return bad('Invalid address.');
    return value.slice(2).toLowerCase().padStart(64, '0');
  }
  if (type === 'bool') {
    if (typeof value !== 'boolean') return bad('bool needs true or false.');
    return hexOf(value ? 1n : 0n);
  }
  const fixed = /^bytes(\d+)$/.exec(type);
  if (fixed) {
    const n = Number(fixed[1]);
    if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value) || value.length !== 2 + n * 2) return bad(`${type} needs exactly ${n} bytes.`);
    return value.slice(2).toLowerCase().padEnd(64, '0');
  }
  return bad(`Unsupported type ${type}.`);
}

function encodeOne(type: string, value: unknown): { head: string; tail: string; dynamic: boolean } {
  if (type === 'bytes' || type === 'string') {
    const hex = type === 'string' ? [...new TextEncoder().encode(String(value))].map((b) => b.toString(16).padStart(2, '0')).join('') : typeof value === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(value) ? value.slice(2).toLowerCase() : bad('Invalid bytes.');
    return { head: '', tail: hexOf(BigInt(hex.length / 2)) + hex.padEnd(Math.ceil(hex.length / 64) * 64, '0'), dynamic: true };
  }
  const arr = arrayOf(type);
  if (arr) {
    if (!Array.isArray(value)) return bad(`${type} needs an array.`);
    if (arr.length !== null && value.length !== arr.length) return bad(`${type} needs exactly ${arr.length} items.`);
    const body = encodeSequence(value.map(() => arr.base), value);
    const dynamic = arr.length === null || isDynamicType(arr.base);
    return { head: '', tail: (arr.length === null ? hexOf(BigInt(value.length)) : '') + body, dynamic };
  }
  const members = tupleMembers(type);
  if (members) {
    if (!Array.isArray(value) || value.length !== members.length) return bad(`${type} needs ${members.length} members.`);
    return { head: '', tail: encodeSequence(members, value), dynamic: isDynamicType(type) };
  }
  return { head: encodeStatic(type, value), tail: '', dynamic: false };
}

/** The head/tail encoding of a list of values (the body of a call, a tuple, or an array). */
function encodeSequence(types: string[], values: unknown[]): string {
  const encoded = types.map((t, i) => encodeOne(t, values[i]));
  const headLen = encoded.reduce((n, e) => n + (e.dynamic ? 32 : e.head ? e.head.length / 2 : e.tail.length / 2), 0);
  let head = '';
  let tail = '';
  for (const e of encoded) {
    if (e.dynamic) {
      head += hexOf(BigInt(headLen + tail.length / 2));
      tail += e.tail;
    } else head += e.head || e.tail; // a static tuple or array is laid out inline
  }
  return head + tail;
}

/** `0x` + selector(signature) + encoded arguments. The types come from the signature itself. */
export function encodeFunction(signature: string, args: unknown[]): string {
  const open = signature.indexOf('(');
  if (open < 0 || !signature.endsWith(')')) return bad('Invalid function signature.');
  const types = splitTop(signature.slice(open + 1, -1));
  if (types.length !== args.length) return bad(`${signature} takes ${types.length} arguments, got ${args.length}.`);
  return '0x' + selector(signature) + encodeSequence(types, args);
}

export function encodeParams(types: string[], values: unknown[]): string {
  return '0x' + encodeSequence(types, values);
}

// ------------------------------------------------------------------ decoding

function decodeAt(type: string, data: string, offset: number): unknown {
  const wordAt = (o: number): bigint => {
    const w = data.slice(o * 2, o * 2 + 64);
    if (w.length !== 64) return bad('The data is too short.');
    return BigInt('0x' + w);
  };
  if (type === 'bytes' || type === 'string') {
    const len = Number(wordAt(offset));
    const raw = data.slice((offset + 32) * 2, (offset + 32 + len) * 2);
    if (raw.length !== len * 2) return bad('The data is too short.');
    return type === 'string' ? new TextDecoder().decode(Uint8Array.from(raw.match(/../g) ?? [], (h) => Number.parseInt(h, 16))) : '0x' + raw;
  }
  const arr = arrayOf(type);
  if (arr) {
    let count = arr.length;
    let start = offset;
    if (count === null) {
      count = Number(wordAt(offset));
      start = offset + 32;
      if (count > 10_000) return bad('The array is implausibly long.');
    }
    return decodeSequence(Array.from({ length: count }, () => arr.base), data, start);
  }
  const members = tupleMembers(type);
  if (members) return decodeSequence(members, data, offset);
  const w = wordAt(offset);
  if (/^u?int\d*$/.test(type)) {
    if (type.startsWith('int')) {
      const bits = BigInt(Number(type.replace(/^int/, '') || '256'));
      return w >= 1n << (bits - 1n) ? w - (1n << 256n) : w;
    }
    return w;
  }
  if (type === 'address') return '0x' + data.slice(offset * 2 + 24, offset * 2 + 64);
  if (type === 'bool') return w !== 0n;
  const fixed = /^bytes(\d+)$/.exec(type);
  if (fixed) return '0x' + data.slice(offset * 2, offset * 2 + Number(fixed[1]) * 2);
  return bad(`Unsupported type ${type}.`);
}

function staticSize(type: string): number {
  const arr = arrayOf(type);
  if (arr) return (arr.length ?? 0) * staticSize(arr.base);
  const members = tupleMembers(type);
  if (members) return members.reduce((n, m) => n + staticSize(m), 0);
  return 32;
}

function decodeSequence(types: string[], data: string, start: number): unknown[] {
  const out: unknown[] = [];
  let cursor = start;
  for (const t of types) {
    if (isDynamicType(t)) {
      const rel = Number(BigInt('0x' + data.slice(cursor * 2, cursor * 2 + 64)));
      out.push(decodeAt(t, data, start + rel));
      cursor += 32;
    } else {
      out.push(decodeAt(t, data, cursor));
      cursor += staticSize(t);
    }
  }
  return out;
}

/** Decodes return data (or an encoded argument list) for the given types. */
export function decodeParams(types: string[], data: string): unknown[] {
  return decodeSequence(types, data.replace(/^0x/, ''), 0);
}
