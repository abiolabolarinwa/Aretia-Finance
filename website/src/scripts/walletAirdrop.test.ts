import { describe, expect, it } from 'vitest';
import { airdropExplanation, airdropReasons, isMine, loadMine, looksLikeAirdrop, markMine, type AirdropCheck } from './walletAirdrop';

const ADDR = '0x1111111111111111111111111111111111111111';
const check = (over: Partial<AirdropCheck>): AirdropCheck => ({ chain: 'bnb', address: ADDR, symbol: 'ABC', name: 'Abc Coin', amount: 8919.28, raw: '8919280000000000000000', decimals: 18, thin: false, ...over });
const storage = () => {
  const s: Record<string, string> = {};
  return { getItem: (k: string) => s[k] ?? null, setItem: (k: string, v: string) => void (s[k] = v) };
};

describe('which tokens look sent, not chosen', () => {
  it('tags the dust seen in the real wallets: a whole number of a token, whatever the pool', () => {
    // 5 AXTQ priced at $956 from a tiny pool; 9 DACITY; 9 Max: the same amounts in unrelated wallets.
    expect(looksLikeAirdrop(check({ symbol: 'AXTQ', name: 'AXTQ', amount: 5, raw: '5000000000000000000', thin: true }))).toBe(true);
    expect(looksLikeAirdrop(check({ symbol: 'DACITY', name: 'Dacity Coin', amount: 9, raw: '9000000000000000000', thin: true }))).toBe(true);
  });

  it('tags 100 of a copycat token from a pool deep enough to be priced, as the TRUMP and ELON dust is', () => {
    expect(airdropReasons(check({ symbol: 'TRUMP', name: 'Trump Meme', amount: 100, raw: '100000000000000000000', thin: false }))).toContain('round-amount');
    expect(looksLikeAirdrop(check({ symbol: 'ELON', name: 'ElonMusk MEME', amount: 100, raw: '100000000000000000000', thin: false }))).toBe(true);
  });

  it('tags a token whose name carries a link or an invitation, even from a deep pool', () => {
    const c = check({ symbol: 'www`discord`gg/DCPri', name: 'Claim your reward at discord.gg', thin: false });
    expect(airdropReasons(c)).toContain('spam-name');
    expect(looksLikeAirdrop(c)).toBe(true);
  });

  it('tags a token that copies a well-known name at another address', () => {
    const c = check({ symbol: 'USDC', name: 'USD Coin', amount: 1234.56, raw: '1234560000000000000000' });
    expect(airdropReasons(c)).toContain('imitates');
    expect(looksLikeAirdrop(c)).toBe(true);
  });

  it('does not tag a token held on purpose: a fractional balance, or a single weak sign', () => {
    // Funds Are Safu: 8,919.28 from a small pool. One sign (shallow pool) is not enough.
    expect(looksLikeAirdrop(check({ symbol: 'SAFU', name: 'Funds Are Safu', thin: true }))).toBe(false);
    expect(looksLikeAirdrop(check({}))).toBe(false);
    // Fractional amounts, as a purchase gives, are never tagged by the amount.
    expect(looksLikeAirdrop(check({ amount: 1637507.30416, raw: '1637507304159977677013854', thin: true }))).toBe(false);
  });

  it('reads a whole number exactly from the raw balance, and falls back on the amount when it is unknown', () => {
    expect(airdropReasons(check({ amount: 3, raw: '3000000', decimals: 6, thin: true }))).toEqual(['shallow-pool', 'round-amount']);
    expect(airdropReasons(check({ amount: 3.000001, raw: '3000001', decimals: 6, thin: true }))).toEqual(['shallow-pool']);
    expect(airdropReasons(check({ amount: 7, raw: null, decimals: null, thin: true }))).toEqual(['shallow-pool', 'round-amount']);
    expect(airdropReasons(check({ amount: 0, raw: '0', decimals: 18, thin: false }))).toEqual([]);
  });

  it('says in a sentence why', () => {
    expect(airdropExplanation(['shallow-pool', 'round-amount'])).toContain('holds very little');
    expect(airdropExplanation([])).toContain('Probably sent');
  });
});

describe('"it is mine"', () => {
  it('remembers the tokens the person claimed, by network and address, whatever the letter case', () => {
    const s = storage();
    expect(loadMine(s).size).toBe(0);
    markMine(s, 'bnb', ADDR.toUpperCase().replace('0X', '0x'));
    const mine = loadMine(s);
    expect(isMine(mine, 'bnb', ADDR)).toBe(true);
    expect(isMine(mine, 'ethereum', ADDR)).toBe(false);
  });
  it('survives storage that is missing, full, or holds rubbish', () => {
    expect(loadMine(null).size).toBe(0);
    expect(markMine(null, 'bnb', ADDR).has(`bnb:${ADDR}`)).toBe(true);
    const bad = { getItem: () => '{not json', setItem: () => { throw new Error('full'); } };
    expect(loadMine(bad).size).toBe(0);
    expect(() => markMine(bad, 'bnb', ADDR)).not.toThrow();
    expect(loadMine({ getItem: () => JSON.stringify(['bnb:' + ADDR, 5, 'x', 'bnb:0xzz']), setItem: () => undefined }).size).toBe(1);
  });
});
