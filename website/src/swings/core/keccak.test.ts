import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { hasValidChecksum, keccak256, toChecksumAddress } from './keccak.js';
import { normalizeTokenRef } from './token.js';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const enc = (s: string) => new TextEncoder().encode(s);

describe('keccak256', () => {
  it('matches the published vectors', () => {
    expect(hex(keccak256(enc('')))).toBe('c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    expect(hex(keccak256(enc('abc')))).toBe('4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  });
  it('handles inputs longer than one block (136 bytes) and exactly one block', () => {
    expect(hex(keccak256(enc('a'.repeat(200))))).toHaveLength(64);
    expect(hex(keccak256(enc('a'.repeat(136))))).not.toBe(hex(keccak256(enc('a'.repeat(135)))));
  });
});

describe('EIP-55', () => {
  const vectors = ['0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB', '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb'];
  it('reproduces the specification vectors', () => {
    for (const v of vectors) expect(toChecksumAddress(v.toLowerCase())).toBe(v);
  });
  it('accepts correct checksums, all-lower and all-upper; rejects a tampered mixed-case address', () => {
    for (const v of vectors) expect(hasValidChecksum(v)).toBe(true);
    expect(hasValidChecksum(vectors[0]!.toLowerCase())).toBe(true);
    expect(hasValidChecksum('0x' + vectors[0]!.slice(2).toUpperCase())).toBe(true);
    const tampered = '0x5AaEb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    expect(hasValidChecksum(tampered)).toBe(false);
    expect(normalizeTokenRef('ethereum', tampered)).toBeNull();
    expect(normalizeTokenRef('ethereum', vectors[0])?.address).toBe(vectors[0]!.toLowerCase());
  });
  it('property: any address round-trips through its checksum form', () => {
    fc.assert(fc.property(fc.stringMatching(/^[0-9a-f]{40}$/), (h) => hasValidChecksum(toChecksumAddress('0x' + h)) && toChecksumAddress(toChecksumAddress('0x' + h)) === toChecksumAddress('0x' + h)));
  });
});
