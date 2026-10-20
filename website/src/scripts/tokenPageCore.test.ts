import { describe, expect, it } from 'vitest';
import { buyRoute, evmCurveView, evmTokenFacts, parseSwapHash, parseTokenPageHash, shortAddress, solanaCurveView, solanaMintFacts, swapHash, swapPath, tokenPageHash, tokenPageUrl, trimPrice, type CurveView } from './tokenPageCore';
import { addressCandidates, solanaHitFromMint } from './walletAddressLookup';
import { tokenOpenMode } from './walletNav';
import type { MintFacts } from './walletLaunchChain';
import type { CurveState } from './walletCurveCore';
import type { EvmCurveState } from './walletCurveEvmCore';

const MINT = 'So11111111111111111111111111111111111111112';
const EVM = '0x4e85bc5bd6f08fa87ceb749372e34226556837e8';

describe('token page address scheme', () => {
  it('parses solana and evm addresses, lower-casing evm', () => {
    expect(parseTokenPageHash(`#/solana/${MINT}`)).toEqual({ chain: 'solana', address: MINT });
    expect(parseTokenPageHash(`#/bnb/${EVM.toUpperCase().replace('0X', '0x')}`)).toEqual({ chain: 'bnb', address: EVM });
    expect(parseTokenPageHash(`#/polygon/${EVM}/`)?.chain).toBe('polygon');
  });
  it('rejects other chains, malformed addresses and other hashes', () => {
    expect(parseTokenPageHash(`#/base/${EVM}`)).toBeNull();
    expect(parseTokenPageHash('#/solana/abc')).toBeNull();
    expect(parseTokenPageHash(`#/ethereum/${MINT}`)).toBeNull();
    expect(parseTokenPageHash('#fees')).toBeNull();
    expect(parseTokenPageHash('')).toBeNull();
  });
  it('builds links that parse back', () => {
    expect(tokenPageUrl('solana', MINT)).toBe(`https://aretiafinance.org/token#/solana/${MINT}`);
    expect(parseTokenPageHash(tokenPageHash('ethereum', EVM))).toEqual({ chain: 'ethereum', address: EVM });
  });
  it('swap links round-trip and open in swap-page mode', () => {
    expect(swapPath('bnb', EVM)).toBe(`/wallet#/swap/bnb/${EVM}`);
    expect(parseSwapHash(swapHash('solana', MINT))).toEqual({ chain: 'solana', address: MINT });
    expect(parseSwapHash('#/swap')).toBeNull();
    expect(parseSwapHash('#/swap/solana/x')).toBeNull();
    expect(tokenOpenMode(swapHash('solana', MINT))).toBe('swap-page');
    expect(tokenOpenMode('#/launch')).toBe('go-to-swap');
  });
  it('shortens', () => expect(shortAddress(MINT)).toBe('So1111…1112'));
});

describe('mint facts', () => {
  const base: MintFacts = { decimals: 9, supply: 1_000_000_000_000_000_000n, mintAuthority: null, freezeAuthority: null, extensions: [], metadataPointer: null, metadata: null };
  it('says fixed and no freeze when both powers are given up', () => {
    const f = solanaMintFacts(base);
    expect(f[0]).toMatchObject({ label: 'Total supply', value: '1,000,000,000' });
    expect(f.find((x) => x.label === 'Supply')?.tone).toBe('good');
    expect(f.find((x) => x.label === 'Freeze power')?.tone).toBe('good');
  });
  it('warns when powers are held or a transfer fee exists', () => {
    const f = solanaMintFacts({ ...base, mintAuthority: MINT, freezeAuthority: MINT, extensions: [1] });
    expect(f.find((x) => x.label === 'Supply')?.tone).toBe('warn');
    expect(f.find((x) => x.label === 'Freeze power')?.tone).toBe('warn');
    expect(f.some((x) => x.label === 'Transfer fee (1)' && x.tone === 'warn')).toBe(true);
  });
  it('lists a permanent delegate, transfer hook and pause switch, and then shows nothing in green (audit M-6)', () => {
    const f = solanaMintFacts({ ...base, extensions: [12, 14, 26] });
    expect(f.filter((x) => x.tone === 'warn').map((x) => x.label)).toEqual(['Permanent delegate (12)', 'Transfer hook (14)', 'Pausable (26)']);
    expect(f.some((x) => x.tone === 'good')).toBe(false);
  });
  it('says a delegate, hook or pause switch nobody holds is given up, and the treasury-held ACT fee is a warning, not "Dangerous"', () => {
    const f = solanaMintFacts({ ...base, extensions: [12, 14, 26], extensionDetails: { permanentDelegate: { delegate: null }, transferHook: { authority: null, programId: null }, pausable: { authority: null, paused: false } } });
    expect(f.filter((x) => x.tone === 'warn')).toEqual([]);
    expect(f.filter((x) => x.value.startsWith('Given up') && x.label.endsWith(')')).map((x) => x.label)).toEqual(['Permanent delegate (12)', 'Transfer hook (14)', 'Pausable (26)']);
    expect(f.find((x) => x.label === 'Supply')?.tone).toBe('good');
    const act = solanaMintFacts({ ...base, extensions: [1, 18], extensionDetails: { transferFee: { configAuthority: 'GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA', withdrawAuthority: 'GtKGE6mQRjpFgb6k4yuQdfgM38qQL5WufSK6wQbryZnA', olderBps: 150, newerBps: 150, newerEpoch: 1031n, maximumFee: 10n ** 18n } } });
    const row = act.find((x) => x.label === 'Transfer fee (1)')!;
    expect(row.value).toBe('Check before you trade: a 1.5% fee is taken on every transfer; the Aretia treasury multisig (2 of 3) can change the rate (a change takes effect only from a later epoch, never at once); the fees go to the Aretia treasury multisig (2 of 3)');
    expect(act.find((x) => x.label === 'Supply')?.tone).toBe('good');
  });
  it('treats metadata and group extensions as neutral, and scaled or confidential amounts as a warning', () => {
    expect(solanaMintFacts({ ...base, extensions: [18, 19, 20, 21, 22, 23] }).filter((x) => x.tone === 'warn')).toEqual([]);
    const f = solanaMintFacts({ ...base, extensions: [18, 19, 25, 24] });
    expect(f.filter((x) => x.tone === 'warn').map((x) => x.label)).toEqual(['Scaled UI amount (25)', 'Confidential mint and burn (24)']);
    expect(f.find((x) => x.label === 'Supply')?.tone).toBe('good');
    // An extension this code does not know is treated as dangerous.
    expect(solanaMintFacts({ ...base, extensions: [99] }).some((x) => x.label === 'Unknown extension (99)' && x.tone === 'warn')).toBe(true);
  });
  it('does not claim evm powers it did not read', () => {
    const f = evmTokenFacts(null, 18);
    expect(f[0]!.tone).toBe('unknown');
    expect(f[1]!.tone).toBe('unknown');
    expect(evmTokenFacts(5n * 10n ** 18n, 18)[0]!.value).toBe('5');
  });
});

describe('curve view', () => {
  const sol: CurveState = { bump: 1, solBump: 1, status: 'trading', creator: MINT, mint: MINT, feeBps: 58, target: 85_000_000_000n, vSol0: 30_000_000_000n, curveTokens: 800n, lpTokens: 200n, vSol: 45_000_000_000n, vTok: 500_000_000_000_000n, realSol: 15_000_000_000n, realTok: 400n, createdAt: 0n, soldOutAt: 0n, pool: null };
  it('reads raised against target and progress', () => {
    const v = solanaCurveView(sol, 6);
    expect(v).toMatchObject({ raised: '15', target: '85', coin: 'SOL', percent: 50, status: 'trading' });
  });
  it('is 100 once finished', () => expect(solanaCurveView({ ...sol, status: 'migrated' }, 6).percent).toBe(100));
  it('evm: none has no view', () => {
    const e: EvmCurveState = { status: 'none', creator: EVM, createdAt: 0n, soldOutAt: 0n, feeBps: 58n, target: 0n, vSol0: 0n, curveTokens: 0n, lpTokens: 0n, vSol: 0n, vTok: 0n, realSol: 0n, realTok: 0n };
    expect(evmCurveView(e, 18, 'ETH')).toBeNull();
    const v = evmCurveView({ ...e, status: 'trading', target: 10n ** 18n, vSol0: 10n ** 17n, vSol: 2n * 10n ** 17n, realSol: 10n ** 17n, curveTokens: 100n, realTok: 90n, vTok: 10n ** 24n }, 18, 'ETH');
    expect(v).toMatchObject({ raised: '0.1', target: '1', coin: 'ETH', percent: 10 });
  });
  it('trims prices without inventing digits', () => {
    expect(trimPrice('0.000000123456789')).toBe('0.000000123456');
    expect(trimPrice('12.3456789')).toBe('12.3456');
    expect(trimPrice('3')).toBe('3');
  });
  it('routes buys: open curve to the curve, else swap, else off', () => {
    const open = { status: 'trading' } as CurveView;
    expect(buyRoute(open, true)).toBe('curve');
    expect(buyRoute({ status: 'migrated' } as CurveView, true)).toBe('swap');
    expect(buyRoute(null, false)).toBe('off');
  });
});

describe('address lookup', () => {
  it('knows which networks an address can be on', () => {
    expect(addressCandidates(MINT)).toEqual(['solana']);
    expect(addressCandidates(EVM)).toEqual(['bnb', 'ethereum', 'polygon']);
    expect(addressCandidates('hello')).toEqual([]);
    expect(addressCandidates('0x123')).toEqual([]);
  });
  it('names an unnamed mint by its address, and uses on-chain metadata when present', () => {
    expect(solanaHitFromMint(MINT, 9, 1n, null).symbol).toBe('So11…1112');
    expect(solanaHitFromMint(MINT, 9, 1n, { name: 'Leaf', symbol: 'LEAF' })).toMatchObject({ symbol: 'LEAF', name: 'Leaf', decimals: 9, fresh: true });
  });
});
