import { describe, expect, it } from 'vitest';
import { base58, base58To32, extensionClass, mintExtensionTypes, mintRuleProblems, readRawMint, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './token2022';
import { parseMintFacts } from './enrich';
import { assessMarketData, assessSolanaToken, hasAdminPowerWarning } from './risk';
import { bandOf } from '../market/rowRisk';

/** A mint with the given TLV entries ([type, length]); no authorities. */
function mint(exts: [number, number][], o: { tail?: number[]; mintAuth?: Uint8Array; freeze?: boolean; supply?: number } = {}): Uint8Array {
  const body: number[] = [];
  for (const [t, l] of exts) body.push(t & 255, t >> 8, l & 255, l >> 8, ...new Array(l).fill(7));
  body.push(...(o.tail ?? []));
  const d = new Uint8Array(166 + body.length);
  d[45] = 1;
  d[44] = 6;
  d[36] = o.supply ?? 100;
  d[165] = 1;
  if (o.mintAuth) {
    d[0] = 1;
    d.set(o.mintAuth, 4);
  }
  if (o.freeze) d[46] = 1;
  d.set(body, 166);
  return d;
}

describe('Token-2022 extensions', () => {
  it('classifies by the real ExtensionType numbers', () => {
    for (const t of [1, 3, 6, 9, 12, 14, 26]) expect(extensionClass(t), String(t)).toBe('bad');
    for (const t of [4, 10, 16, 24, 25]) expect(extensionClass(t), String(t)).toBe('warn');
    for (const t of [18, 19, 20, 21, 22, 23]) expect(extensionClass(t), String(t)).toBe('neutral');
    expect(extensionClass(77)).toBe('bad');
  });
  it('reads the types in order, and refuses a truncated entry', () => {
    expect(mintExtensionTypes(mint([[18, 64], [19, 90], [12, 32]]))).toEqual([18, 19, 12]);
    expect(mintExtensionTypes(mint([[18, 64]]).subarray(0, 200))).toBeNull();
    expect(mintExtensionTypes(new Uint8Array(82).fill(0).map((_, i) => (i === 45 ? 1 : 0)))).toEqual([]);
  });
  it('round-trips 32-byte keys in base58', () => {
    const k = new Uint8Array(32).map((_, i) => i * 7);
    expect(base58To32(base58(k))).toEqual(k);
    expect(base58To32('1'.repeat(32))).toEqual(new Uint8Array(32));
    expect(base58To32('not base58!')).toBeNull();
  });
});

describe('the on-chain mint rule (check_mint), audit M-6', () => {
  it('passes a finished Aretia launch: metadata extensions only, no authorities, exact length or zero padding', () => {
    expect(mintRuleProblems(TOKEN_2022_PROGRAM, mint([[18, 64], [19, 90]]))).toEqual([]);
    expect(mintRuleProblems(TOKEN_2022_PROGRAM, mint([[18, 64], [19, 90]], { tail: [0, 0, 0, 0, 0] }))).toEqual([]);
  });
  it('refuses anything else', () => {
    expect(mintRuleProblems(TOKEN_PROGRAM, mint([]))).toEqual(['not a Token-2022 mint']);
    expect(mintRuleProblems(TOKEN_2022_PROGRAM, mint([[18, 64], [12, 32]])).join()).toMatch(/Permanent delegate/);
    expect(mintRuleProblems(TOKEN_2022_PROGRAM, mint([[18, 64], [19, 90]], { freeze: true }))).toEqual(['a freeze authority is set']);
    expect(mintRuleProblems(TOKEN_2022_PROGRAM, mint([[18, 64]], { tail: [0, 0, 0, 0, 9] }))).toEqual(['data after the extensions']);
    expect(mintRuleProblems(TOKEN_2022_PROGRAM, mint([[18, 64]], { tail: [18, 0, 200, 0] }))).toEqual(['the extensions do not end at the end of the data']);
  });
  it('lets the creator hold the mint authority only while nothing is minted', () => {
    const creator = new Uint8Array(32).fill(3);
    expect(mintRuleProblems(TOKEN_2022_PROGRAM, mint([[18, 64]], { mintAuth: creator, supply: 0 }), base58(creator))).toEqual([]);
    expect(mintRuleProblems(TOKEN_2022_PROGRAM, mint([[18, 64]], { mintAuth: creator, supply: 5 }), base58(creator))).toEqual(['a mint authority is still set']);
    expect(mintRuleProblems(TOKEN_2022_PROGRAM, mint([[18, 64]], { mintAuth: creator, supply: 0 }), base58(new Uint8Array(32).fill(4)))).toEqual(['a mint authority is still set']);
    expect(mintRuleProblems(TOKEN_2022_PROGRAM, mint([[18, 64]], { mintAuth: creator, supply: 0 }))).toEqual(['a mint authority is still set']);
  });
  it('reads the name and symbol from the metadata', () => {
    const enc = (t: string) => [t.length, 0, 0, 0, ...new TextEncoder().encode(t)];
    const meta = [...new Array(64).fill(0), ...enc('Name'), ...enc('SYM'), ...enc('u'), 0, 0, 0, 0];
    const d = mint([]);
    const full = new Uint8Array(d.length + 4 + meta.length);
    full.set(d);
    full.set([19, 0, meta.length, 0, ...meta], d.length);
    expect(readRawMint(full)).toMatchObject({ name: 'Name', symbol: 'SYM', extensions: [19], mintAuthority: null });
  });
});

describe('the risk engine judges each extension (audit M-6, L-16)', () => {
  const facts = (exts: [number, number][]) => parseMintFacts(TOKEN_2022_PROGRAM, mint(exts))!;
  const market = { top10Pct: 30, top10Basis: 'wallets' as const, liquidityUsd: 60000, volume24hUsd: 20000, poolCount: 1, ageHours: 100 };

  it('a permanent-delegate honeypot is restricted, not "unverified" (PoC risk2)', () => {
    const r = assessSolanaToken({ ...facts([[12, 32]]), ...market });
    expect(r.status).toBe('restricted');
    expect(hasAdminPowerWarning(r)).toBe(true);
    for (const t of [14, 26, 9]) expect(assessSolanaToken({ ...facts([[t, 8]]), ...market }).status, String(t)).toBe('restricted');
    expect(assessSolanaToken({ ...facts([[1, 108]]), ...market }).signals.find((s) => s.id === 'extensions')?.state).toBe('bad');
  });

  it('the metadata extensions every Aretia launch carries are not a warning', () => {
    const r = assessSolanaToken({ ...facts([[18, 64], [19, 90]]), ...market });
    expect(r.signals.find((s) => s.id === 'extensions')?.state).toBe('ok');
    expect(r.score).toBe(0);
    expect(assessSolanaToken({ ...facts([[18, 64], [25, 56]]), ...market }).signals.find((s) => s.id === 'extensions')?.state).toBe('warn');
  });

  it('market data alone, or a token with admin powers, is never the green "Established" (PoC market)', () => {
    const big = { liquidityUsd: 6e6, volume24hUsd: 6e5, poolCount: 1, ageHours: 9000 };
    expect(bandOf(assessMarketData(big).status)).not.toBe('green');
    const s = assessSolanaToken({ mintAuthoritySet: true, freezeAuthoritySet: true, hasExtensions: true, top10Pct: 70, ...big });
    expect(bandOf(s.status)).not.toBe('green');
    expect(assessSolanaToken({ mintAuthoritySet: true, freezeAuthoritySet: false, hasExtensions: false, top10Pct: 10, ...big }).status).not.toBe('established');
    expect(assessSolanaToken({ mintAuthoritySet: false, freezeAuthoritySet: false, extensionTypes: [18, 19], top10Pct: 10, ...big }).status).toBe('established');
  });
});
