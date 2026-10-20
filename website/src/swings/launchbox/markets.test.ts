import { describe, expect, it } from 'vitest';
import { bestPools } from './markets';
import { chooseDexPair } from '../charts/dexscreener';

const TOK = 'So1anaLaunchTokenAddress1111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const real = { chainId: 'solana', dexId: 'raydium', pairAddress: 'RealPoolRealPoolRealPool1111', baseToken: { address: TOK }, quoteToken: { address: WSOL, symbol: 'SOL' }, priceUsd: '0.0001', liquidity: { usd: 3000 }, marketCap: 100000 };
const fake = { chainId: 'solana', dexId: 'meteora', pairAddress: 'FakePoolFakePoolFakePool1111', baseToken: { address: TOK }, quoteToken: { address: 'FakeQuoteMintFakeQuoteMint11111111111111111', symbol: 'USDC' }, priceUsd: '5', liquidity: { usd: 90_000_000 }, marketCap: 5_000_000_000 };

describe('a pool against a made-up token does not take over the numbers (audit M-8)', () => {
  it('Launch Box takes the pool paired with a major token, whatever the other pool claims', () => {
    for (const pairs of [[real, fake], [fake, real]]) {
      const m = bestPools(pairs as never, 'solana', [TOK]).get(TOK)!;
      expect(m.pool.address).toBe('RealPoolRealPoolRealPool1111');
      expect(m).toMatchObject({ priceUsd: 0.0001, liquidityUsd: 3000, capUsd: 100000 });
      expect(m.pool).toMatchObject({ quoteSymbol: 'SOL', quoteMajor: true });
    }
  });

  it('with only an unknown-quoted pool, shows its price labelled with the quote token, and no liquidity or market cap', () => {
    const m = bestPools([fake] as never, 'solana', [TOK]).get(TOK)!;
    expect(m).toMatchObject({ priceUsd: 5, liquidityUsd: null, capUsd: null, capKind: null });
    expect(m.pool).toMatchObject({ quoteSymbol: 'USDC', quoteMajor: false });
  });

  it('among major-paired pools, the deepest wins (EVM addresses in any case)', () => {
    const t = '0x' + 'ab'.repeat(20);
    const usdt = '0x55d398326f99059ff775485246999027b3197955';
    const wbnb = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
    const p = (addr: string, quote: string, liq: number) => ({ chainId: 'bsc', dexId: 'pancake', pairAddress: addr, baseToken: { address: t.toUpperCase().replace('0X', '0x') }, quoteToken: { address: quote.toUpperCase().replace('0X', '0x') }, priceUsd: '1', liquidity: { usd: liq } });
    const m = bestPools([p('0xp1', usdt, 10_000), p('0xp2', wbnb, 50_000), p('0xp3', '0x' + '99'.repeat(20), 9e9)] as never, 'bnb', [t]).get(t)!;
    expect(m.pool.address).toBe('0xp2');
  });

  it('the chart and token page pick the real pool too, even when the fake one reports 30,000 times its depth', () => {
    const c = chooseDexPair('solana', TOK, [fake, real])!;
    expect((c.p as { pairAddress: string }).pairAddress).toBe('RealPoolRealPoolRealPool1111');
    // A small real pool (under the $1,000 floor) still wins over a pool against an unknown token.
    const tiny = { ...real, liquidity: { usd: 400 } };
    expect((chooseDexPair('solana', TOK, [fake, tiny])!.p as { pairAddress: string }).pairAddress).toBe('RealPoolRealPoolRealPool1111');
  });
});
