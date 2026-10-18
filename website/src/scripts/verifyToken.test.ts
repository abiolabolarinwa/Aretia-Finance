/* The pure part of the "Verified by Aretia" check script (scripts/verifyTokenCore.mjs), loaded by a computed path like the revenue report. */
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
const spec = '../../scripts/verifyTokenCore.mjs';
const core: any = await import(/* @vite-ignore */ spec);
const { TOKEN_2022_PROGRAM, automatedPass, checkEvm, checkSolana, readSolanaMint, renderReport } = core;

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** A legacy mint: supply 1000, 6 decimals; authorities as given (32 bytes of 7 means "present"). */
function mint(opts: { mintAuth?: boolean; freeze?: boolean; ext?: number[] } = {}): Uint8Array {
  const ext = opts.ext ?? [];
  const size = ext.length ? 166 + ext.reduce((n) => n + 4 + 8, 0) : 82;
  const d = new Uint8Array(size);
  const v = new DataView(d.buffer);
  if (opts.mintAuth) {
    v.setUint32(0, 1, true);
    d.fill(7, 4, 36);
  }
  v.setBigUint64(36, 1000n, true);
  d[44] = 6;
  d[45] = 1;
  if (opts.freeze) {
    v.setUint32(46, 1, true);
    d.fill(9, 50, 82);
  }
  if (ext.length) {
    d[165] = 1;
    let at = 166;
    for (const t of ext) {
      v.setUint16(at, t, true);
      v.setUint16(at + 2, 8, true);
      at += 12;
    }
  }
  return d;
}

describe('Solana mints', () => {
  it('passes a mint with no authorities', () => {
    const r = checkSolana(readSolanaMint(TOKEN, mint()));
    expect(r.supplyFixed.pass).toBe(true);
    expect(r.powersGivenUp.pass).toBe(true);
    expect(automatedPass(r)).toBe(true);
  });
  it('fails a live mint authority and a live freeze authority separately', () => {
    const a = checkSolana(readSolanaMint(TOKEN, mint({ mintAuth: true })));
    expect(a.supplyFixed.pass).toBe(false);
    expect(a.powersGivenUp.pass).toBe(true);
    const b = checkSolana(readSolanaMint(TOKEN, mint({ freeze: true })));
    expect(b.supplyFixed.pass).toBe(true);
    expect(b.powersGivenUp.pass).toBe(false);
    expect(automatedPass(b)).toBe(false);
  });
  it('fails Token-2022 extensions that hand someone control, and tolerates harmless ones', () => {
    expect(checkSolana(readSolanaMint(TOKEN_2022_PROGRAM, mint({ ext: [14] }))).powersGivenUp.detail).toMatch(/transfer hook/);
    expect(checkSolana(readSolanaMint(TOKEN_2022_PROGRAM, mint({ ext: [12] }))).powersGivenUp.pass).toBe(false);
    expect(checkSolana(readSolanaMint(TOKEN_2022_PROGRAM, mint({ ext: [1] }))).powersGivenUp.detail).toMatch(/transfer fee/);
    expect(checkSolana(readSolanaMint(TOKEN_2022_PROGRAM, mint({ ext: [18] }))).powersGivenUp.pass).toBe(true); // metadata pointer
  });
  it('never passes something it cannot read', () => {
    for (const bad of [readSolanaMint('11111111111111111111111111111111', mint()), readSolanaMint(TOKEN, new Uint8Array(10)), readSolanaMint(TOKEN, new Uint8Array(82))]) {
      expect(bad.ok).toBe(false);
      expect(automatedPass(checkSolana(bad))).toBe(false);
    }
  });
});

describe('Ethereum-style tokens', () => {
  const plain = '0x6080604052' + '63' + '18160ddd' + '63' + 'a9059cbb';
  it('passes code with no mint, pause or owner function and a steady supply', () => {
    expect(automatedPass(checkEvm(plain, '100', '100'))).toBe(true);
  });
  it('fails mint, and fails pause or owner functions separately', () => {
    const m = checkEvm(plain + '6340c10f19', '100', '100');
    expect(m.supplyFixed.pass).toBe(false);
    expect(m.powersGivenUp.pass).toBe(true);
    const p = checkEvm(plain + '638456cb59' + '638da5cb5b', '100', '100');
    expect(p.supplyFixed.pass).toBe(true);
    expect(p.powersGivenUp.detail).toMatch(/pause\(\)/);
  });
  it('fails when the supply moved, is unreadable, or there is no contract', () => {
    expect(checkEvm(plain, '100', '101').supplyFixed.pass).toBe(false);
    expect(checkEvm(plain, null, null).supplyFixed.pass).toBe(false);
    expect(automatedPass(checkEvm('0x', null, null))).toBe(false);
  });
});

describe('the report', () => {
  it('lists the two checks a person must record and the disclaimer', () => {
    const text = renderReport({ chain: 'solana', token: 'T', when: 'now', automated: checkSolana(readSolanaMint(TOKEN, mint())) });
    expect(text).toMatch(/\[PASS\] The supply is fixed/);
    expect(text).toMatch(/project link and creator match/);
    expect(text).toMatch(/locked pool or curve exists/);
    expect(text).toMatch(/not an audit, not an endorsement/);
  });
});
