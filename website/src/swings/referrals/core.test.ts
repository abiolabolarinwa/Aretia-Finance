import { describe, expect, it } from 'vitest';
import { ARETIA_FEE_BPS } from '../core/fee.js';
import { REFERRAL_CONFIG, captureFromSearch, decideCredit, impliedVolume, inWindow, isMutual, isSelf, parseReferrer, readStoredRef, referralLink, referrerPercentOfVolume, shareOf, totalsByChainAsset, windowMs, type PriorCredit, type ReferralConfig } from './core.js';

const NOW = 1_800_000_000_000;
const EVM_A = '0x' + 'a'.repeat(40);
const EVM_B = '0x' + 'b'.repeat(40);
const SOL = '2tcBrd1JQjL8VHNFRYB1EurbyLiVAKZTYTYk94aVoZX2';
const cfg: ReferralConfig = { ...REFERRAL_CONFIG };

describe('the share', () => {
  it('is 20% of the fee, so about 0.116% of the swap, and traders still pay the same 0.58%', () => {
    expect(ARETIA_FEE_BPS).toBe(58);
    expect(REFERRAL_CONFIG.shareBps).toBe(2000);
    expect(referrerPercentOfVolume()).toBe('0.116%');
    // 1 SOL swap: fee 0.0058 SOL, referrer 0.00116 SOL, Aretia keeps 0.00464.
    const fee = 5_800_000n;
    expect(shareOf(fee)).toBe(1_160_000n);
    expect(fee - shareOf(fee)).toBe(4_640_000n);
  });
  it('rounds down, never above the fee, and is zero for nonsense', () => {
    expect(shareOf(7n)).toBe(1n);
    expect(shareOf(4n)).toBe(0n);
    expect(shareOf(0n)).toBe(0n);
    expect(shareOf(-5n)).toBe(0n);
    expect(shareOf(100n, 20_000)).toBe(0n);
    expect(shareOf(100n, 10_000)).toBe(100n);
    expect(shareOf(100n, 12.5)).toBe(0n);
  });
  it('estimates the volume from the fee', () => {
    expect(impliedVolume(5_800_000n)).toBe(1_000_000_000n);
  });
});

describe('the window', () => {
  it('lasts 90 days from the binding and not a moment longer', () => {
    expect(REFERRAL_CONFIG.windowDays).toBe(90);
    expect(inWindow(NOW, NOW)).toBe(true);
    expect(inWindow(NOW, NOW + windowMs() - 1)).toBe(true);
    expect(inWindow(NOW, NOW + windowMs())).toBe(false);
    expect(inWindow(NOW, NOW - 1)).toBe(false);
    expect(inWindow(NOW, NOW + 10 * 86_400_000, { windowDays: 7 })).toBe(false);
  });
});

describe('who a referrer is', () => {
  it('accepts an EVM or a Solana address and nothing else', () => {
    expect(parseReferrer(EVM_A.toUpperCase().replace('0X', '0x'))).toMatchObject({ family: 'evm', address: EVM_A, owner: `evm:${EVM_A}` });
    expect(parseReferrer(SOL)).toMatchObject({ family: 'solana', owner: `solana:${SOL}` });
    for (const bad of ['', 'hello', '0x123', 'a@b.com', SOL + '!', 'https://evil.example/?x=1', 123, null, undefined, '0x' + 'g'.repeat(40)]) expect(parseReferrer(bad)).toBeNull();
  });
  it('treats the same address in any letter case as oneself', () => {
    expect(isSelf(`evm:${EVM_A}`, `evm:${EVM_A.toUpperCase()}`)).toBe(true);
    expect(isSelf(`evm:${EVM_A}`, `evm:${EVM_B}`)).toBe(false);
    expect(isSelf(`evm:${EVM_A}`, `solana:${SOL}`)).toBe(false);
  });
  it('refuses two people who named each other', () => {
    expect(isMutual('evm:a', 'evm:b', [{ trader: 'evm:b', referrer: 'evm:a' }])).toBe(true);
    expect(isMutual('evm:a', 'evm:b', [{ trader: 'evm:c', referrer: 'evm:a' }])).toBe(false);
    expect(isMutual('evm:a', 'evm:b', [])).toBe(false);
  });
});

const prior = (n: number, over: Partial<PriorCredit> = {}, spacingMs = 3_600_000): PriorCredit[] =>
  Array.from({ length: n }, (_, i) => ({ referrer: 'evm:r', trader: `evm:t${i}`, asset: 'usdc', feeRaw: BigInt(1000 + i), at: NOW - 1000 - i * spacingMs, status: 'credited' as const, ...over }));
const base = { referrer: 'evm:r', trader: 'evm:t', asset: 'usdc', feeRaw: 5_800n, at: NOW, chainFamily: 'evm' as const, referrerFamily: 'evm' as const };

describe('deciding a credit', () => {
  it('credits a normal swap with 20% of the fee', () => {
    expect(decideCredit(base, [])).toEqual({ status: 'credited', shareRaw: 1_160n });
  });
  it('earns nothing when the referrer cannot be paid on that kind of chain', () => {
    expect(decideCredit({ ...base, referrerFamily: 'solana' }, [])).toEqual({ status: 'family', shareRaw: 0n });
  });
  it('stops at the daily cap per referrer, but counts only the last day', () => {
    const cap = { ...cfg, dailyCapPerReferrer: 5 };
    expect(decideCredit(base, prior(5, {}, 1000), cap).status).toBe('capped');
    expect(decideCredit(base, prior(4, {}, 1000), cap).status).toBe('credited');
    expect(decideCredit(base, prior(5, {}, 86_400_000 * 2), cap).status).toBe('credited');
    expect(decideCredit(base, prior(5, { referrer: 'evm:other' }, 1000), cap).status).toBe('credited');
  });
  it('stops at the daily cap per trader', () => {
    const cap = { ...cfg, dailyCapPerTrader: 3 };
    expect(decideCredit(base, prior(3, { trader: 'evm:t', feeRaw: 0n }, 1_000_000), cap).status).toBe('capped');
  });
  it('does not count flagged or capped rows towards the caps', () => {
    const cap = { ...cfg, dailyCapPerReferrer: 2 };
    expect(decideCredit(base, prior(5, { status: 'flagged' }, 1000), cap).status).toBe('credited');
  });
  it('flags a burst of identical fee payments from one trader (a script), and earns nothing for it', () => {
    const burst = prior(REFERRAL_CONFIG.washRepeat - 1, { trader: 'evm:t', feeRaw: 5_800n }, 10_000);
    expect(decideCredit(base, burst)).toEqual({ status: 'flagged', shareRaw: 0n });
    expect(decideCredit(base, burst.slice(1)).status).toBe('credited');
    expect(decideCredit(base, burst.map((c) => ({ ...c, feeRaw: 1n }))).status).toBe('credited');
    expect(decideCredit(base, burst.map((c) => ({ ...c, at: c.at - 3_600_000 }))).status).toBe('credited');
  });
});

describe('totals', () => {
  it('add up only credited rows, per chain and coin, in whole smallest units', () => {
    const row = (chain: string, asset: string, fee: bigint, status: 'credited' | 'capped' = 'credited') => ({ chain, asset, status, feeRaw: fee, shareRaw: shareOf(fee), trader: 't' });
    const t = totalsByChainAsset([row('solana', 'SOL', 5_800_000n), row('solana', 'SOL', 5_800_000n), row('solana', 'SOL', 99n, 'capped'), row('bnb', 'usdt', 5_800_000_000_000_000_000n)]);
    expect(t).toHaveLength(2);
    expect(t.find((x) => x.chain === 'solana')).toMatchObject({ swaps: 2, feeRaw: 11_600_000n, owedRaw: 2_320_000n, volumeRaw: 2_000_000_000n });
  });
});

describe('the visitor link', () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it('stores only the address and an expiry, and the first referrer wins', () => {
    const s = store();
    const first = captureFromSearch(`?ref=${EVM_A}&utm=x`, s, NOW)!;
    expect(first).toEqual({ ref: EVM_A, at: NOW, expiresAt: NOW + windowMs() });
    expect(Object.keys(JSON.parse(s.getItem('aretia-referrer-v1')!))).toEqual(['ref', 'at', 'expiresAt']);
    expect(captureFromSearch(`?ref=${EVM_B}`, s, NOW + 1000)!.ref).toBe(EVM_A);
  });
  it('ignores a bad value, and lets a new link in once the old one has expired', () => {
    const s = store();
    expect(captureFromSearch('?ref=not-an-address', s, NOW)).toBeNull();
    expect(captureFromSearch('', s, NOW)).toBeNull();
    captureFromSearch(`?ref=${EVM_A}`, s, NOW);
    expect(readStoredRef(s, NOW + windowMs() + 1)).toBeNull();
    expect(captureFromSearch(`?ref=${EVM_B}`, s, NOW + windowMs() + 1)!.ref).toBe(EVM_B);
  });
  it('survives a storage that is missing or throws', () => {
    expect(() => captureFromSearch(`?ref=${EVM_A}`, null, NOW)).not.toThrow();
    expect(captureFromSearch(`?ref=${EVM_A}`, { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } }, NOW)).toBeNull();
  });
  it('builds the link a referrer shares', () => {
    expect(referralLink(EVM_A)).toBe(`https://aretiafinance.org/?ref=${EVM_A}`);
  });
});
