import { describe, expect, it } from 'vitest';
import { mintTransferFeeBps, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './solanaTools.js';


describe('mintTransferFeeBps (Token-2022 transfer-fee extension)', () => {
  const put16 = (d: Uint8Array, o: number, v: number) => new DataView(d.buffer).setUint16(o, v, true);
  const put64 = (d: Uint8Array, o: number, v: bigint) => new DataView(d.buffer).setBigUint64(o, v, true);
  /** A Token-2022 mint: 82-byte base, padding to 165, account type 1, then TLV extensions. */
  const mint2022 = (exts: { type: number; value: Uint8Array }[]): Uint8Array => {
    const len = 166 + exts.reduce((n, e) => n + 4 + e.value.length, 0);
    const d = new Uint8Array(len);
    d[44] = 6;
    d[45] = 1;
    d[165] = 1;
    let o = 166;
    for (const e of exts) {
      put16(d, o, e.type);
      put16(d, o + 2, e.value.length);
      d.set(e.value, o + 4);
      o += 4 + e.value.length;
    }
    return d;
  };
  const feeConfig = (older: number, newer: number): Uint8Array => {
    const v = new Uint8Array(108);
    put64(v, 72, 0n); // older epoch
    put64(v, 80, 1_000_000n); // older maximum fee
    put16(v, 88, older);
    put64(v, 90, 500n); // newer epoch
    put64(v, 98, 1_000_000n);
    put16(v, 106, newer);
    return v;
  };

  it('is null for a classic token, and for a Token-2022 mint with no extensions', () => {
    expect(mintTransferFeeBps(TOKEN_PROGRAM_ID, new Uint8Array(82))).toBeNull();
    expect(mintTransferFeeBps(TOKEN_2022_PROGRAM_ID, new Uint8Array(82))).toBeNull();
    expect(mintTransferFeeBps(TOKEN_2022_PROGRAM_ID, mint2022([]))).toBeNull();
  });

  it('reads the fee, taking the higher of the current and the scheduled rate so the disclosure is never too low', () => {
    expect(mintTransferFeeBps(TOKEN_2022_PROGRAM_ID, mint2022([{ type: 1, value: feeConfig(350, 150) }]))).toBe(350);
    expect(mintTransferFeeBps(TOKEN_2022_PROGRAM_ID, mint2022([{ type: 1, value: feeConfig(150, 350) }]))).toBe(350);
  });

  it('finds the extension after other extensions', () => {
    expect(mintTransferFeeBps(TOKEN_2022_PROGRAM_ID, mint2022([{ type: 14, value: new Uint8Array(64) }, { type: 1, value: feeConfig(100, 100) }]))).toBe(100);
  });

  it('is null for a Token-2022 mint with other extensions only, and never throws on hostile data', () => {
    expect(mintTransferFeeBps(TOKEN_2022_PROGRAM_ID, mint2022([{ type: 14, value: new Uint8Array(64) }]))).toBeNull();
    const truncated = mint2022([{ type: 1, value: feeConfig(1, 1) }]).slice(0, 180);
    expect(mintTransferFeeBps(TOKEN_2022_PROGRAM_ID, truncated)).toBeNull();
    const lying = mint2022([]);
    const d = new Uint8Array(lying.length + 4);
    d.set(lying);
    put16(d, lying.length, 1);
    put16(d, lying.length + 2, 60_000); // claims a huge length
    expect(mintTransferFeeBps(TOKEN_2022_PROGRAM_ID, d)).toBeNull();
    expect(mintTransferFeeBps('SomeOtherProgram', mint2022([{ type: 1, value: feeConfig(100, 100) }]))).toBeNull();
  });
});
