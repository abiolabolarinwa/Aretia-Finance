import { describe, expect, it, vi } from 'vitest';
import { DexScreenerPoolFinder, pickDexPair } from './dexscreener.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const WSOL = 'So11111111111111111111111111111111111111112';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const pair = (id: string, base: [string, string], quote: [string, string], liq: number, over: Record<string, unknown> = {}) => ({
  chainId: 'solana', pairAddress: id.padEnd(32, 'A'), baseToken: { address: base[0], symbol: base[1] }, quoteToken: { address: quote[0], symbol: quote[1] },
  priceUsd: '2', priceChange: { h24: 1.5 }, volume: { h24: 1000 }, liquidity: { usd: liq }, txns: { h24: { buys: 3, sells: 4 } }, info: { imageUrl: 'https://cdn.dexscreener.com/x.png' }, ...over,
});

describe('which pool the chart shows', () => {
  it('prefers a pool where the token is the first token, so the chart is of the token itself', () => {
    const info = pickDexPair('solana', USDC, [pair('solusdc', [WSOL, 'SOL'], [USDC, 'USDC'], 9_000_000), pair('usdcusdt', [USDC, 'USDC'], [USDT, 'USDT'], 2_000_000)])!;
    expect(info.poolName).toBe('USDC / USDT');
    expect(info.targetIsBase).toBe(true);
  });

  it('ignores a first-token pool that is tiny next to the real market, and says plainly which pair is drawn instead', () => {
    const info = pickDexPair('solana', USDC, [pair('solusdc', [WSOL, 'SOL'], [USDC, 'USDC'], 9_000_000), pair('dust', [USDC, 'USDC'], [BONK, 'BONK'], 800)])!;
    expect(info.poolName).toBe('SOL / USDC');
    expect(info.targetIsBase).toBe(false);
    expect(info.baseSymbol).toBe('SOL');
    expect(info.quoteSymbol).toBe('USDC');
  });

  it('among first-token pools, puts those paired with a major token ahead of deeper ones paired with an unknown token', () => {
    const info = pickDexPair('solana', BONK, [pair('inflated', [BONK, 'BONK'], ['Fake1111111111111111111111111111111111111', 'FAKE'], 50_000_000), pair('real', [BONK, 'BONK'], [WSOL, 'SOL'], 4_000_000)])!;
    expect(info.pool.startsWith('real')).toBe(true);
  });

  it('reads the header numbers from the same pair that is drawn', () => {
    const info = pickDexPair('solana', BONK, [pair('real', [BONK, 'BONK'], [WSOL, 'SOL'], 4_000_000, { priceUsd: '0.00002', priceChange: { h24: -3.2 } })])!;
    expect(info).toMatchObject({ priceUsd: 0.00002, change24h: -3.2, volume24hUsd: 1000, liquidityUsd: 4_000_000, trades24h: 7, icon: 'https://cdn.dexscreener.com/x.png' });
  });

  it('skips other networks, malformed pairs and pairs the token is not in, and returns null when nothing is left', () => {
    expect(pickDexPair('solana', BONK, [pair('x', [WSOL, 'SOL'], [USDC, 'USDC'], 1000)])).toBeNull();
    expect(pickDexPair('solana', BONK, [pair('x', [BONK, 'BONK'], [WSOL, 'SOL'], 1000, { chainId: 'ethereum' })])).toBeNull();
    expect(pickDexPair('solana', BONK, [{ pairAddress: 'short' }, null, 'junk'])).toBeNull();
    expect(pickDexPair('solana', BONK, { not: 'an array' })).toBeNull();
  });

  it('matches EVM addresses whatever their capitals, and drops an unsafe picture link', () => {
    const t = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const info = pickDexPair('base', t, [{ ...pair('p', [t.toUpperCase().replace('0X', '0x'), 'USDC'], ['0x4200000000000000000000000000000000000006', 'WETH'], 5_000_000), chainId: 'base', info: { imageUrl: 'javascript:alert(1)' } }])!;
    expect(info.targetIsBase).toBe(true);
    expect(info.icon).toBeNull();
  });
});

describe('the finder', () => {
  const reply = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('asks DexScreener for the token, shows the pool, and reuses a recent answer', async () => {
    const f = vi.fn(reply([pair('real', [BONK, 'BONK'], [WSOL, 'SOL'], 4_000_000)]));
    const finder = new DexScreenerPoolFinder(f, 'https://api.dexscreener.com', () => 1000, 20_000);
    const a = await finder.find('solana', BONK);
    await finder.find('solana', BONK);
    expect(a.poolName).toBe('BONK / SOL');
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toBe(`https://api.dexscreener.com/tokens/v1/solana/${BONK}`);
  });

  it('says so plainly when there is no pool, the service is busy, or it cannot be reached', async () => {
    await expect(new DexScreenerPoolFinder(reply([])).find('solana', BONK)).rejects.toThrow(/No trading pool/);
    await expect(new DexScreenerPoolFinder(reply({}, 429)).find('solana', BONK)).rejects.toThrow(/busy/);
    await expect(new DexScreenerPoolFinder((async () => { throw new Error('offline'); }) as unknown as typeof fetch).find('solana', BONK)).rejects.toThrow(/could not be reached/);
    await expect(new DexScreenerPoolFinder(reply([])).find('solana', 'not an address')).rejects.toThrow(/not a valid/);
  });
});
