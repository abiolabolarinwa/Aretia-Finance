import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { decodeParams, encodeFunction, encodeParams, isDynamicType } from './abiGeneric.js';
import { encodeCall, uint, address, addressArray, bytesArray, tupleArray, wordOfAddress, wordOfBool } from './abi.js';

const w = (s: string | number | bigint) => (typeof s === 'string' ? s.replace('0x', '') : BigInt(s).toString(16)).padStart(64, '0');
const rpadHex = (s: string) => s.padEnd(64, '0');

describe('generic ABI: the Solidity specification worked examples', () => {
  it('baz(uint32,bool) with (69, true)', () => {
    expect(encodeFunction('baz(uint32,bool)', [69, true])).toBe('0xcdcd77c0' + w(0x45) + w(1));
  });

  it('bar(bytes3[2]) with ("abc","def")', () => {
    expect(encodeFunction('bar(bytes3[2])', [['0x616263', '0x646566']])).toBe('0xfce353f6' + rpadHex('616263') + rpadHex('646566'));
  });

  it('sam(bytes,bool,uint256[]) with ("dave", true, [1,2,3])', () => {
    const expected = '0xa5643bf2' + w(0x60) + w(1) + w(0xa0) + w(4) + rpadHex('64617665') + w(3) + w(1) + w(2) + w(3);
    expect(encodeFunction('sam(bytes,bool,uint256[])', ['0x64617665', true, [1n, 2n, 3n]])).toBe(expected);
  });

  it('f(uint256,uint32[],bytes10,bytes) with (0x123, [0x456, 0x789], "1234567890", "Hello, world!")', () => {
    const hello = '48656c6c6f2c20776f726c6421';
    const expected = '0x8be65246' + w(0x123) + w(0x80) + rpadHex('31323334353637383930') + w(0xe0) + w(2) + w(0x456) + w(0x789) + w(13) + rpadHex(hello);
    expect(encodeFunction('f(uint256,uint32[],bytes10,bytes)', [0x123n, [0x456, 0x789], '0x31323334353637383930', '0x' + hello])).toBe(expected);
  });

  it('decodes them back', () => {
    const data = encodeFunction('f(uint256,uint32[],bytes10,bytes)', [0x123n, [0x456, 0x789], '0x31323334353637383930', '0x48656c6c6f2c20776f726c6421']).slice(10);
    expect(decodeParams(['uint256', 'uint32[]', 'bytes10', 'bytes'], data)).toEqual([0x123n, [0x456n, 0x789n], '0x31323334353637383930', '0x48656c6c6f2c20776f726c6421']);
  });
});

describe('generic ABI: nested and dynamic structures', () => {
  const A = '0x' + 'a1'.repeat(20);
  const B = '0x' + 'b2'.repeat(20);

  it('a struct holding a dynamic member round-trips, as Balancer SingleSwap does', () => {
    const type = '(bytes32,uint8,address,address,uint256,bytes)';
    const value = ['0x' + '11'.repeat(32), 0, A, B, 1_000n, '0x'];
    const enc = encodeParams([type, '(address,bool,address,bool)', 'uint256', 'uint256'], [value, [A, false, B, false], 5n, 6n]);
    const dec = decodeParams([type, '(address,bool,address,bool)', 'uint256', 'uint256'], enc);
    expect(dec).toEqual([['0x' + '11'.repeat(32), 0n, A, B, 1_000n, '0x'], [A, false, B, false], 5n, 6n]);
    expect(isDynamicType(type)).toBe(true);
    expect(isDynamicType('(address,bool)')).toBe(false);
  });

  it('arrays of structs, arrays of arrays and strings round-trip', () => {
    const types = ['(address,uint256)[]', 'uint256[][]', 'string', 'int256[]'];
    const values = [[[A, 1n], [B, 2n]], [[1n], [2n, 3n], []], 'héllo', [-5n, 7n]];
    expect(decodeParams(types, encodeParams(types, values))).toEqual([[[A, 1n], [B, 2n]], [[1n], [2n, 3n], []], 'héllo', [-5n, 7n]]);
  });

  it('agrees with the simpler encoder used elsewhere in Swings', () => {
    const sig = 'swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)';
    const hops = [[A, B, true, A]];
    const simple = encodeCall(sig, [uint(5n), uint(1n), tupleArray([[wordOfAddress(A), wordOfAddress(B), wordOfBool(true), wordOfAddress(A)]]), address(B), uint(9n)]);
    expect(encodeFunction(sig, [5n, 1n, hops, B, 9n])).toBe(simple);
    expect(encodeFunction('f(address[],bytes[])', [[A, B], ['0xdeadbeef']])).toBe(encodeCall('f(address[],bytes[])', [addressArray([A, B]), bytesArray(['0xdeadbeef'])]));
  });

  it('refuses malformed values', () => {
    expect(() => encodeFunction('f(uint8)', [256])).toThrow(/does not fit/);
    expect(() => encodeFunction('f(uint256)', [-1n])).toThrow();
    expect(() => encodeFunction('f(address)', ['0x12'])).toThrow();
    expect(() => encodeFunction('f(bool)', [1])).toThrow();
    expect(() => encodeFunction('f(bytes4)', ['0x1234'])).toThrow();
    expect(() => encodeFunction('f(uint256[2])', [[1n]])).toThrow();
    expect(() => encodeFunction('f(uint256)', [])).toThrow();
    expect(() => decodeParams(['uint256'], '0x12')).toThrow();
  });

  it('property: integers, addresses, bytes and nested arrays always round-trip', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 256n) - 1n }), fc.bigInt({ min: -(1n << 255n), max: (1n << 255n) - 1n }), fc.stringMatching(/^[0-9a-f]{40}$/), fc.uint8Array({ maxLength: 100 }), fc.array(fc.array(fc.bigInt({ min: 0n, max: 1000n }), { maxLength: 4 }), { maxLength: 4 }), (u, i, addr, bytes, nested) => {
        const hex = '0x' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
        const types = ['uint256', 'int256', 'address', 'bytes', 'uint256[][]'];
        const out = decodeParams(types, encodeParams(types, [u, i, '0x' + addr, hex, nested]));
        const norm = (x: unknown): string => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
        return out[0] === u && out[1] === i && out[2] === '0x' + addr && out[3] === hex && norm(out[4]) === norm(nested);
      }),
    );
  });
});
