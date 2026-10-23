import { describe, expect, it } from 'vitest';
import { decodeBase58, encodeBase58, findProgramAddress, isOnCurve, isSolanaAddress, metadataAddress, METADATA_PROGRAM, whirlpoolPriceScaled } from './accounts.js';
import { scaledToString } from '../math.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';

describe('library-free Solana helpers', () => {
  it('round-trips base58 including leading zero bytes', () => {
    for (const s of [USDC, WSOL, '11111111111111111111111111111111', METADATA_PROGRAM]) expect(encodeBase58(decodeBase58(s)!)).toBe(s);
    expect(decodeBase58('0OIl')).toBeNull();
    expect(encodeBase58(Uint8Array.of(0, 0, 1))).toBe('112');
  });
  it('recognises public keys', () => {
    expect(isSolanaAddress(USDC)).toBe(true);
    expect(isSolanaAddress('0x' + 'a'.repeat(40))).toBe(false);
    expect(isSolanaAddress('abc')).toBe(false);
    expect(isSolanaAddress(5)).toBe(false);
  });
  it('derives the same metadata account as the chain (vector confirmed on mainnet in accounts.live.ts)', () => {
    expect(metadataAddress(USDC)).toBe('5x38Kp4hvdomTCnCrAny4UtMUt5rQBdB6px2K1Ui45Wq');
  });
  it('a derived address is never on the curve', () => {
    const pda = findProgramAddress([new TextEncoder().encode('x')], METADATA_PROGRAM)!;
    expect(isOnCurve(decodeBase58(pda.address)!)).toBe(false);
    expect(pda.bump).toBeLessThanOrEqual(255);
    expect(isOnCurve(new Uint8Array(31))).toBe(false);
  });
  it('prices a whirlpool exactly from its sqrt price', () => {
    // sqrt price 2^64 means a raw ratio of 1; token A has 9 decimals and B has 6, so 1 A is worth 1000 B.
    expect(scaledToString(whirlpoolPriceScaled(1n << 64n, 9, 6)!)).toBe('1000');
    expect(whirlpoolPriceScaled(0n, 9, 6)).toBeNull();
  });
});
