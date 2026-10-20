import { describe, expect, it } from 'vitest';
import { bestPools } from './markets';
import { chooseDexPair } from '../charts/dexscreener';

const TOK = 'So1anaLaunchTokenAddress1111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const real = { chainId: 'solana', dexId: 'raydium', pairAddress: 'RealPoolRealPoolRealPool1111', baseToken: { address: TOK }, quoteToken: { address: WSOL, symbol: 'SOL' }, priceUsd: '0.0001', liquidity: { usd: 3000 }, marketCap: 100000 };
const fake = { chainId: 'solana', dexId: 'meteora', pairAddress: 'FakePoolFakePoolFakePool1111', baseToken: { address: TOK }, quoteToken: { address: 'FakeQuoteMintFakeQuoteMint11111111111111111', symbol: 'USDC' }, priceUsd: '5', liquidity: { usd: 90_000_000 }, marketCap: 5_000_000_000 };

describe('a pool against a made-up token does not take over the numbers (audit M-8)', () => {
  it('Launch Box takes the pool paired with a major token when it holds 5% of the deepest pool, whatever order they come in', () => {
    const solid = { ...real, liquidity: { usd: 5_000_000 } };
    for (const pairs of [[solid, fake], [fake, solid]]) {
      const m = bestPools(pairs as never, 'solana', [TOK]).get(TOK)!;
      expect(m.pool.address).toBe('RealPoolRealPoolRealPool1111');
      expect(m).toMatchObject({ priceUsd: 0.0001, liquidityUsd: 5_000_000, capUsd: 100000 });
      expect(m.pool).toMatchObject({ quoteSymbol: 'SOL', quoteMajor: true });
    }
  });

  it('a real major-paired pool over the $1,000 floor wins however much a pool against a made-up token claims', () => {
    for (const pairs of [[real, fake], [fake, real]]) {
      const m = bestPools(pairs as never, 'solana', [TOK]).get(TOK)!;
      expect(m.pool.address).toBe('RealPoolRealPoolRealPool1111');
    }
  });

  it('with only an unknown-quoted pool, shows its price labelled with the quote token, and no liquidity or market cap', () => {
    const m = bestPools([fake] as never, 'solana', [TOK]).get(TOK)!;
    expect(m).toMatchObject({ priceUsd: 5, liquidityUsd: null, capUsd: null, capKind: null });
    expect(m.pool).toMatchObject({ quoteSymbol: 'USDC', quoteMajor: false });
  });

  it('among major-paired pools deep enough to count, the deepest wins (EVM addresses in any case)', () => {
    const t = '0x' + 'ab'.repeat(20);
    const usdt = '0x55d398326f99059ff775485246999027b3197955';
    const wbnb = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
    const p = (addr: string, quote: string, liq: number) => ({ chainId: 'bsc', dexId: 'pancake', pairAddress: addr, baseToken: { address: t.toUpperCase().replace('0X', '0x') }, quoteToken: { address: quote.toUpperCase().replace('0X', '0x') }, priceUsd: '1', liquidity: { usd: liq } });
    const m = bestPools([p('0xp1', usdt, 10_000), p('0xp2', wbnb, 50_000), p('0xp3', '0x' + '99'.repeat(20), 900_000)] as never, 'bnb', [t]).get(t)!;
    expect(m.pool).toMatchObject({ address: '0xp2', quoteMajor: true });
  });

  it('the chart and token page pick the real pool when it holds real money, and otherwise say the drawn price is not major-backed', () => {
    const solid = { ...real, liquidity: { usd: 5_000_000 } };
    const c = chooseDexPair('solana', TOK, [fake, solid])!;
    expect((c.p as { pairAddress: string }).pairAddress).toBe('RealPoolRealPoolRealPool1111');
    expect(c.majorBacked).toBe(true);
    // A real pool 30,000 times smaller than the claimed one still stands for the price: claimed liquidity proves nothing.
    const small = chooseDexPair('solana', TOK, [fake, real])!;
    expect((small.p as { pairAddress: string }).pairAddress).toBe('RealPoolRealPoolRealPool1111');
    expect(small.majorBacked).toBe(true);
    // A small major pool (under the $1,000 floor) with nothing else is drawn, flagged.
    const tiny = { ...real, liquidity: { usd: 400 } };
    expect(chooseDexPair('solana', TOK, [tiny])!.majorBacked).toBe(false);
  });
});

describe('a dust major pool does not outrank a deep real market (re-audit M-8)', () => {
  const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
  const dust = { chainId: 'solana', dexId: 'raydium', pairAddress: 'DustPoolDustPoolDustPool1111', url: 'https://dexscreener.com/solana/dust', baseToken: { address: TOK }, quoteToken: { address: WSOL, symbol: 'SOL' }, priceUsd: '9', liquidity: { usd: 3 }, marketCap: 9e12 };
  const deep = { chainId: 'solana', dexId: 'meteora', pairAddress: 'JupPoolJupPoolJupPool1111111', url: 'https://dexscreener.com/solana/jup', baseToken: { address: TOK }, quoteToken: { address: JUP, symbol: 'JUP' }, priceUsd: '0.42', liquidity: { usd: 2_000_000 }, marketCap: 4_200_000 };

  it('Launch Box uses the $2M JUP pool, labels the quote, and shows no liquidity or cap from it', () => {
    for (const pairs of [[dust, deep], [deep, dust]]) {
      const m = bestPools(pairs as never, 'solana', [TOK]).get(TOK)!;
      expect(m.priceUsd).toBe(0.42);
      expect(m.pool).toMatchObject({ address: 'JupPoolJupPoolJupPool1111111', quoteSymbol: 'JUP', quoteMajor: false });
      expect(m).toMatchObject({ liquidityUsd: null, capUsd: null });
    }
  });

  it('the chart draws the JUP pool, flagged as not major-backed', () => {
    const c = chooseDexPair('solana', TOK, [dust, deep])!;
    expect((c.p as { pairAddress: string }).pairAddress).toBe('JupPoolJupPoolJupPool1111111');
    expect(c.majorBacked).toBe(false);
  });

  it('a major pool with $1,000 and 5% of the deepest wins again', () => {
    const fair = { ...dust, liquidity: { usd: 100_000 } };
    expect(bestPools([deep, fair] as never, 'solana', [TOK]).get(TOK)!.pool).toMatchObject({ address: 'DustPoolDustPoolDustPool1111', quoteMajor: true });
    expect(chooseDexPair('solana', TOK, [deep, fair])!.majorBacked).toBe(true);
  });
});
