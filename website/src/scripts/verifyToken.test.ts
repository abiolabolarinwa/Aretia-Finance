/* The pure part of the "Verified by Aretia" check script (scripts/verifyTokenCore.mjs), loaded by a computed path like the revenue report. */
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
const spec = '../../scripts/verifyTokenCore.mjs';
const core: any = await import(/* @vite-ignore */ spec);
const { TOKEN_2022_PROGRAM, automatedPass, checkEvm, checkSolana, readSolanaMint, renderReport, proxyReason, hasDelegatecall, delegationTarget } = core;

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

describe('audit M-7: the real extension numbers, an allow-list, and proxies', () => {
  it('fails Pausable, ScaledUi, MintClose, ConfidentialFee, ConfidentialMintBurn, permanent delegate and unknown types (PoC vt.mjs)', () => {
    for (const t of [26, 25, 3, 16, 24, 12, 4, 11, 99]) {
      const r = checkSolana(readSolanaMint(TOKEN_2022_PROGRAM, mint({ ext: [18, 19, t] })));
      expect(r.powersGivenUp.pass, String(t)).toBe(false);
    }
    expect(checkSolana(readSolanaMint(TOKEN_2022_PROGRAM, mint({ ext: [26] }))).powersGivenUp.detail).toMatch(/pausable \(26\)/);
  });
  it('passes metadata and group extensions, and passes interest-bearing with a flag', () => {
    expect(checkSolana(readSolanaMint(TOKEN_2022_PROGRAM, mint({ ext: [18, 19, 20, 21, 22, 23] }))).powersGivenUp.pass).toBe(true);
    const i = checkSolana(readSolanaMint(TOKEN_2022_PROGRAM, mint({ ext: [18, 10] })));
    expect(i.powersGivenUp.pass).toBe(true);
    expect(i.powersGivenUp.detail).toMatch(/Flagged for the reviewer: interest-bearing \(10\)/);
  });
  it('prints every extension in the report', () => {
    const automated = checkSolana(readSolanaMint(TOKEN_2022_PROGRAM, mint({ ext: [18, 19, 14] })));
    const text = renderReport({ chain: 'solana', token: 'T', when: 'now', automated });
    expect(text).toMatch(/Token-2022 extensions \(3\):/);
    expect(text).toMatch(/metadata pointer \(18\): allowed/);
    expect(text).toMatch(/transfer hook \(14\): NOT ALLOWED/);
  });
  it('fails EIP-1167 minimal proxies and EIP-1967 proxies (PoC vt.mjs)', () => {
    const minimal = '0x363d3d373d3d3d363d73' + '11'.repeat(20) + '5af43d82803e903d91602b57fd5bf3';
    const r = checkEvm(minimal, '1000', '1000');
    expect(r.supplyFixed.pass).toBe(false);
    expect(r.powersGivenUp.pass).toBe(false);
    expect(r.powersGivenUp.detail).toMatch(/EIP-1167/);
    const plain = '0x6080604052' + '63' + '18160ddd' + '63' + 'a9059cbb';
    const slot = checkEvm(plain, '1', '1', { implementationSlot: '0x' + '0'.repeat(24) + '22'.repeat(20) });
    expect(automatedPass(slot)).toBe(false);
    expect(slot.powersGivenUp.detail).toMatch(/EIP-1967 proxy: its implementation slot points to 0x2222/);
    expect(proxyReason(plain, '0x' + '0'.repeat(64))).toBeNull();
    expect(proxyReason(plain + '635c60da1b')).toMatch(/implementation\(\)/);
  });
  it('names the two blocks the supply was read at', () => {
    const plain = '0x6080604052' + '63' + '18160ddd';
    expect(checkEvm(plain, '5', '5', { blocks: [100, 130] }).supplyFixed.detail).toMatch(/blocks 100 and 130/);
  });
});

describe('re-audit M-7: EIP-7702 delegated accounts and DELEGATECALL', () => {
  const plain = '0x6080604052' + '63' + '18160ddd' + '63' + 'a9059cbb';
  it('fails an EIP-7702 delegation designator', () => {
    const code = '0xef0100' + '33'.repeat(20);
    expect(delegationTarget(code)).toBe('0x' + '33'.repeat(20));
    const r = checkEvm(code, '1', '1');
    expect(automatedPass(r)).toBe(false);
    expect(r.powersGivenUp.detail).toMatch(/EIP-7702 delegated account: its code runs in 0x3333/);
    expect(delegationTarget(plain)).toBeNull();
  });
  it('fails code with a DELEGATECALL opcode, found by an instruction walk', () => {
    // PUSH1 0 DUP1 ... GAS DELEGATECALL: a hand-rolled proxy that is neither EIP-1167 nor EIP-1967.
    const r = checkEvm(plain + '5af4', '1', '1');
    expect(r.powersGivenUp.pass).toBe(false);
    expect(r.powersGivenUp.detail).toMatch(/DELEGATECALL/);
    expect(hasDelegatecall('0x6000f4')).toBe(true);
  });
  it('does not count a 0xf4 inside PUSH1..PUSH32 data or in the trailing metadata', () => {
    expect(hasDelegatecall('0x60f4')).toBe(false);
    expect(hasDelegatecall('0x7f' + 'f4'.repeat(32) + '00')).toBe(false);
    expect(hasDelegatecall('0x63f4f4f4f4' + '01')).toBe(false);
    // Solidity metadata: a2 64 'ipfs' 58 22 <34-byte hash with f4 in it> ... then the 2-byte length.
    const cbor = 'a264697066735822' + 'f4'.repeat(34) + '64736f6c6343' + '000814' + '0033';
    expect(hasDelegatecall('0x6080604052' + 'fe' + cbor)).toBe(false);
    expect(automatedPass(checkEvm(plain + 'fe' + cbor, '1', '1'))).toBe(true);
    // A truncated PUSH at the end is not an opcode either.
    expect(hasDelegatecall('0x7ff4')).toBe(false);
  });
});
