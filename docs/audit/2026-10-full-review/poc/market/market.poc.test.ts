import { describe, it, expect } from 'vitest';
import * as web3 from '@solana/web3.js';
import { parseMintAccount } from '../../../../../website/src/scripts/walletLaunchChain';
import { solanaMintFacts } from '../../../../../website/src/scripts/tokenPageCore';
import { bestPools } from '../../../../../website/src/swings/launchbox/markets';
import { chooseDexPair } from '../../../../../website/src/swings/charts/dexscreener';
import { isUnsafeName } from '../../../../../website/src/swings/tokens/safeText';
import { cleanText } from '../../../../../website/src/swings/launchbox/core';
import { assessMarketData, assessSolanaToken } from '../../../../../website/src/swings/tokens/risk';
import { bandOf } from '../../../../../website/src/swings/market/rowRisk';

const T22 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
function mint(exts: [number, number][]) {
  const body: number[] = [];
  for (const [t, l] of exts) body.push(t & 255, t >> 8, l & 255, l >> 8, ...new Array(l).fill(7));
  const d = new Uint8Array(166 + body.length); d[45] = 1; d[44] = 6; d[36] = 100; d[165] = 1; d.set(body, 166); return d;
}
describe('PoC', () => {
  it('token page calls a permanent-delegate + transfer-hook + pausable mint fixed/given-up', () => {
    const f = parseMintAccount(web3 as never, T22, mint([[12, 32], [14, 64], [26, 65]]))!;
    expect(f.extensions).toEqual([12, 14, 26]);
    const facts = solanaMintFacts(f);
    console.log(JSON.stringify(facts));
    expect(facts.some((x) => x.tone === 'warn')).toBe(false);
  });
  it('launch box bestPools takes the inflated fake-quote pool', () => {
    const tok = 'So1anaLaunchTokenAddress1111111111111111111';
    const pairs = [
      { chainId: 'solana', dexId: 'raydium', pairAddress: 'RealPoolRealPoolRealPool1111', baseToken: { address: tok }, quoteToken: { address: 'So11111111111111111111111111111111111111112' }, priceUsd: '0.0001', liquidity: { usd: 3000 }, marketCap: 100000 },
      { chainId: 'solana', dexId: 'meteora', pairAddress: 'FakePoolFakePoolFakePool1111', baseToken: { address: tok }, quoteToken: { address: 'FakeQuoteMintFakeQuoteMint11111111111111111' }, priceUsd: '5', liquidity: { usd: 90000000 }, marketCap: 5000000000 },
    ];
    const m = bestPools(pairs as never, 'solana', [tok]).get(tok)!;
    console.log(m);
    expect(m.pool.address).toBe('FakePoolFakePoolFakePool1111');
    const c = chooseDexPair('solana', tok, pairs)!;
    expect((c.p as { pairAddress: string }).pairAddress).toBe('FakePoolFakePoolFakePool1111');
  });
  it('lookalike filter misses fullwidth and mathematical letters; cleanText keeps U+061C/U+FEFF/U+2060', () => {
    expect(isUnsafeName('ＵＳＤＣ', 'USD Coin')).toBe(false);
    expect(isUnsafeName('𝖴𝖲𝖣𝖢', 'USD Coin')).toBe(false);
    expect(isUnsafeName('USDC', 'USD Coin')).toBe(false);
    expect(cleanText('US؜DC﻿⁠', 32).length).toBe(7);
  });
  it('market data alone gives a green Established rating', () => {
    const r = assessMarketData({ liquidityUsd: 6e6, volume24hUsd: 6e5, poolCount: 1, ageHours: 9000 });
    console.log(r.status, r.score);
    expect(bandOf(r.status)).toBe('green');
    const s = assessSolanaToken({ mintAuthoritySet: true, freezeAuthoritySet: true, hasExtensions: true, top10Pct: 70, liquidityUsd: 6e6, volume24hUsd: 6e5, poolCount: 1, ageHours: 9000 });
    console.log(s.status, s.score);
    expect(bandOf(s.status)).toBe('green');
  });
});
