import { describe, expect, it, vi } from 'vitest';
import { dexScreenerEmbedUrl, embedUrl, GeckoPoolFinder, pickPool, type GeckoPool } from './pool.js';

const ACT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL = 'So11111111111111111111111111111111111111112';
const POOL = '6n8Mvd7xmZs66E5VLGQGvtE31gbKMcTL4S97W4oV6ivX';

const pool = (address: string, over: { liq?: string; base: string; quote: string; basePrice?: string; quotePrice?: string; change?: string; vol?: string; buys?: number; sells?: number; name?: string }): GeckoPool => ({
  attributes: { address, name: over.name ?? 'X / Y', reserve_in_usd: over.liq ?? '1000', base_token_price_usd: over.basePrice ?? '0.005', quote_token_price_usd: over.quotePrice ?? '1', price_change_percentage: { h24: over.change ?? '1.5' }, volume_usd: { h24: over.vol ?? '250' }, transactions: { h24: { buys: over.buys ?? 3, sells: over.sells ?? 4 } } },
  relationships: { base_token: { data: { id: `solana_${over.base}` } }, quote_token: { data: { id: `solana_${over.quote}` } } },
});

describe('pickPool', () => {
  it('reads the price, change, volume, liquidity and trade count of the token\'s own side', () => {
    const info = pickPool('solana', ACT, [pool(POOL, { base: ACT, quote: USDC, liq: '24752.24', basePrice: '0.005001', change: '0.4', vol: '12', buys: 2, sells: 5, name: 'ACT / USDC' })])!;
    expect(info).toEqual({ network: 'solana', pool: POOL, poolName: 'ACT / USDC', priceUsd: 0.005001, change24h: 0.4, volume24hUsd: 12, liquidityUsd: 24752.24, trades24h: 7 });
  });

  it('uses the quote side\'s price when the token is the pool\'s quote token', () => {
    const info = pickPool('solana', WSOL, [pool(POOL, { base: 'SomeOtherBaseToken111111111111111111111111111', quote: WSOL, basePrice: '0.0000004', quotePrice: '118.5' })])!;
    expect(info.priceUsd).toBe(118.5);
  });

  it('prefers a pool paired with a major token over a deeper-looking pool paired with something else', () => {
    const inflated = pool('InflatedPoolAddress1234567890', { base: ACT, quote: 'SomeMadeUpTokenMint1111111111111111111', liq: '180000000' });
    const real = pool(POOL, { base: ACT, quote: USDC, liq: '24000' });
    expect(pickPool('solana', ACT, [inflated, real])!.pool).toBe(POOL);
  });

  it('breaks ties by depth, then by the service\'s own order', () => {
    const a = pool('PoolAAAAAAAAAAAAAAAAAAAAAAAA', { base: ACT, quote: USDC, liq: '10' });
    const b = pool('PoolBBBBBBBBBBBBBBBBBBBBBBBB', { base: ACT, quote: USDC, liq: '90' });
    expect(pickPool('solana', ACT, [a, b])!.pool).toBe('PoolBBBBBBBBBBBBBBBBBBBBBBBB');
    expect(pickPool('solana', ACT, [pool('PoolCCCCCCCCCCCCCCCCCCCCCCCC', { base: ACT, quote: USDC, liq: '5' }), pool('PoolDDDDDDDDDDDDDDDDDDDDDDDD', { base: ACT, quote: USDC, liq: '5' })])!.pool).toBe('PoolCCCCCCCCCCCCCCCCCCCCCCCC');
  });

  it('ignores pools that do not hold the token, or have unusable addresses, and says nothing is usable', () => {
    expect(pickPool('solana', ACT, [pool(POOL, { base: 'OtherA11111111111111111111111111111111111111', quote: 'OtherB11111111111111111111111111111111111111' })])).toBeNull();
    expect(pickPool('solana', ACT, [pool('bad address!', { base: ACT, quote: USDC })])).toBeNull();
    expect(pickPool('solana', ACT, [])).toBeNull();
  });

  it('reports a missing or non-positive price as unknown rather than zero', () => {
    expect(pickPool('solana', ACT, [pool(POOL, { base: ACT, quote: USDC, basePrice: '0' })])!.priceUsd).toBeNull();
    expect(pickPool('solana', ACT, [pool(POOL, { base: ACT, quote: USDC, basePrice: 'nope' })])!.priceUsd).toBeNull();
  });
});

describe('embedUrl', () => {
  it('points at GeckoTerminal\'s own chart for the pool, in the form the Trade tab uses', () => {
    const url = new URL(embedUrl({ network: 'solana', pool: POOL }));
    expect(url.origin + url.pathname).toBe(`https://www.geckoterminal.com/solana/pools/${POOL}`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ embed: '1', info: '0', swaps: '1', chart_type: 'price', resolution: '15m' });
  });
});

describe('GeckoPoolFinder', () => {
  const serve = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const ok = { data: [pool(POOL, { base: ACT, quote: USDC })] };

  it('finds the pool and reuses a recent answer, then asks again when it is stale or forced', async () => {
    const f = serve(200, ok);
    let t = 1_000;
    const finder = new GeckoPoolFinder(f, undefined, () => t, 20_000);
    expect((await finder.find('solana', ACT)).pool).toBe(POOL);
    await finder.find('solana', ACT);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    await finder.find('solana', ACT, undefined, true);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
    t += 21_000;
    await finder.find('solana', ACT);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3);
  });

  it('says plainly when there is no pool, the service is busy, unreachable or unreadable, and refuses a bad address without asking', async () => {
    await expect(new GeckoPoolFinder(serve(200, { data: [] })).find('solana', ACT)).rejects.toMatchObject({ code: 'no-route' });
    await expect(new GeckoPoolFinder(serve(404, {})).find('solana', ACT)).rejects.toMatchObject({ code: 'no-route' });
    await expect(new GeckoPoolFinder(serve(429, {})).find('solana', ACT)).rejects.toThrow(/busy/);
    await expect(new GeckoPoolFinder((async () => { throw new Error('offline'); }) as unknown as typeof fetch).find('solana', ACT)).rejects.toThrow(/could not be reached/);
    await expect(new GeckoPoolFinder((async () => new Response('not json', { status: 200 })) as unknown as typeof fetch).find('solana', ACT)).rejects.toThrow(/unreadable/);
    const f = serve(200, ok);
    await expect(new GeckoPoolFinder(f).find('ethereum', 'nope')).rejects.toMatchObject({ code: 'invalid' });
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('asks the right network for an EVM token', async () => {
    const f = serve(200, { data: [{ attributes: { address: '0x4e68ccd3e89f51c3074ca5072bbac773960dfa36', name: 'WETH / USDT', reserve_in_usd: '5' }, relationships: { base_token: { data: { id: 'eth_0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' } }, quote_token: { data: { id: 'eth_0xdac17f958d2ee523a2206206994597c13d831ec7' } } } }] });
    const info = await new GeckoPoolFinder(f).find('ethereum', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2');
    expect(info.network).toBe('eth');
    expect(String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain('/networks/eth/tokens/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2/pools');
  });
});

describe('dexScreenerEmbedUrl', () => {
  it('points at the real DexScreener host with the networks own name, in the light embedded style', () => {
    const u = new URL(dexScreenerEmbedUrl('bnb', '0xabc'));
    expect(u.origin).toBe('https://dexscreener.com');
    expect(u.pathname).toBe('/bsc/0xabc');
    expect(u.searchParams.get('embed')).toBe('1');
    expect(u.searchParams.get('theme')).toBe('light');
    expect(u.searchParams.get('info')).toBe('0');
    expect(new URL(dexScreenerEmbedUrl('solana', 'P')).pathname).toBe('/solana/P');
    expect(new URL(dexScreenerEmbedUrl('avalanche', 'P')).pathname).toBe('/avalanche/P');
  });

  it('cannot be pointed elsewhere by a pool value', () => {
    const u = new URL(dexScreenerEmbedUrl('base', '../../evil?x=1#y'));
    expect(u.origin).toBe('https://dexscreener.com');
    expect(u.pathname.startsWith('/base/')).toBe(true);
    expect(u.hash).toBe('');
  });
});
