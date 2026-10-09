import { describe, expect, it, vi } from 'vitest';
import { fetchPairDetail, parsePairDetail } from './pairDetail.js';
import { dexScreenerEmbedUrl } from './pool.js';

const NOW = 1_800_000_000_000;
const PAIR = 'Pair'.padEnd(40, 'x');
const raw = (over: Record<string, unknown> = {}) => ({
  pairs: [{
    dexId: 'pancakeswap', pairAddress: PAIR, baseToken: { symbol: 'BAI', name: 'Binance AI' }, quoteToken: { symbol: 'WBNB' }, priceUsd: '0.003713', priceNative: '0.0000054963', liquidity: { usd: 103000 }, fdv: 3_700_000, marketCap: 3_700_000,
    priceChange: { m5: 5.05, h1: -0.18, h6: 449000, h24: 449000 }, txns: { m5: { buys: 5, sells: 2 }, h1: { buys: 100, sells: 90 }, h6: { buys: 900, sells: 800 }, h24: { buys: 6169, sells: 3495 } }, volume: { m5: 100, h1: 2000, h6: 90000, h24: 3_400_000 }, pairCreatedAt: NOW - 3 * 3_600_000,
    info: { imageUrl: 'https://cdn.dexscreener.com/bai.png', websites: [{ label: 'Website', url: 'https://bai.example/' }, { label: 'Evil', url: 'javascript:alert(1)' }], socials: [{ type: 'twitter', url: 'https://x.com/bai' }, { type: 'telegram', url: 'http://insecure.example/t' }] }, ...over,
  }],
});

describe('the pair behind the token page', () => {
  it('reads prices, value, changes, buys and sells, volume and age', () => {
    const d = parsePairDetail(raw(), NOW)!;
    expect(d).toMatchObject({ pair: PAIR, dex: 'pancakeswap', baseSymbol: 'BAI', quoteSymbol: 'WBNB', name: 'Binance AI', priceUsd: 0.003713, priceNative: 0.0000054963, liquidityUsd: 103000, fdvUsd: 3_700_000, marketCapUsd: 3_700_000, ageMs: 3 * 3_600_000 });
    expect(d.change).toEqual({ m5: 5.05, h1: -0.18, h6: 449000, h24: 449000 });
    expect(d.buys.h24).toBe(6169);
    expect(d.sells.h24).toBe(3495);
    expect(d.volumeUsd.h24).toBe(3_400_000);
    expect(d.icon).toBe('https://cdn.dexscreener.com/bai.png');
  });

  it('keeps only https links, labelled', () => {
    expect(parsePairDetail(raw(), NOW)!.links).toEqual([{ label: 'Website', url: 'https://bai.example/' }, { label: 'Twitter', url: 'https://x.com/bai' }]);
  });

  it('leaves what the service does not report as null, not zero', () => {
    const d = parsePairDetail(raw({ txns: {}, volume: {}, priceChange: {}, liquidity: undefined, fdv: undefined, marketCap: undefined, pairCreatedAt: undefined, priceUsd: undefined, info: undefined }), NOW)!;
    expect(d.buys).toEqual({ m5: null, h1: null, h6: null, h24: null });
    expect(d.volumeUsd.h1).toBeNull();
    expect(d).toMatchObject({ liquidityUsd: null, fdvUsd: null, marketCapUsd: null, ageMs: null, priceUsd: null, icon: null, links: [] });
  });

  it('refuses an answer with no pair or a malformed one', () => {
    expect(parsePairDetail({ pairs: [] }, NOW)).toBeNull();
    expect(parsePairDetail(null, NOW)).toBeNull();
    expect(parsePairDetail({ pairs: [{ pairAddress: PAIR }] }, NOW)).toBeNull();
  });
});

describe('fetching it', () => {
  const reply = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('asks for exactly that pool on that network', async () => {
    const f = vi.fn(reply(raw()));
    await fetchPairDetail('bnb', PAIR, f as unknown as typeof fetch, () => NOW);
    expect(String(f.mock.calls[0]![0])).toBe(`https://api.dexscreener.com/latest/dex/pairs/bsc/${PAIR}`);
  });

  it('explains a busy service, an unreachable one, an unknown pool and a bad address', async () => {
    await expect(fetchPairDetail('solana', PAIR, reply({}, 429))).rejects.toThrow(/busy/);
    await expect(fetchPairDetail('solana', PAIR, (async () => { throw new Error('x'); }) as unknown as typeof fetch)).rejects.toThrow(/could not be reached/);
    await expect(fetchPairDetail('solana', PAIR, reply({ pairs: [] }))).rejects.toThrow(/No details/);
    await expect(fetchPairDetail('solana', '../../x', reply({}))).rejects.toThrow(/not a valid pool/);
  });
});

describe('the full chart address', () => {
  it('can show the chart toolbar for the token page, and keeps it off for the small chart', () => {
    expect(new URL(dexScreenerEmbedUrl('solana', PAIR)).searchParams.get('chartLeftToolbar')).toBe('0');
    expect(new URL(dexScreenerEmbedUrl('solana', PAIR, '15', { toolbar: true })).searchParams.get('chartLeftToolbar')).toBe('1');
    expect(new URL(dexScreenerEmbedUrl('solana', PAIR, '15', { toolbar: true })).searchParams.get('info')).toBe('0');
  });
});
