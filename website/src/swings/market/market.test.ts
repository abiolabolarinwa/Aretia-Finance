import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { compactCount, compactUsd, formatAge, formatChange, formatPrice, sortRows, type MarketRow } from './types.js';
import { GeckoMarket, parseGeckoPools } from './gecko.js';
import { rowFromRecord, rowsFromRecords } from './registryRows.js';
import type { TokenRecord } from '../core/types.js';

const NOW = 1_800_000_000_000;
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

describe('number formatting', () => {
  it('writes prices the way trading screens do, with a zero count for tiny ones', () => {
    expect(formatPrice(0.002907)).toBe('$0.002907');
    expect(formatPrice(0.0000008793)).toBe('$0.0₆8793');
    expect(formatPrice(0.00008793)).toBe('$0.0₄8793');
    expect(formatPrice(0.00001)).toBe('$0.0₄1');
    expect(formatPrice(1.2)).toBe('$1.2');
    expect(formatPrice(732.94)).toBe('$732.94');
    expect(formatPrice(65_000)).toBe('$65,000');
    for (const bad of [null, 0, -1, Number.NaN]) expect(formatPrice(bad as number | null)).toBe('–');
  });

  it('shortens money, counts, changes and ages', () => {
    expect(compactUsd(4_300_000)).toBe('$4.3M');
    expect(compactUsd(161_000)).toBe('$161K');
    expect(compactUsd(74)).toBe('$74');
    expect(compactUsd(14_100_000_000)).toBe('$14.1B');
    expect(compactUsd(null)).toBe('–');
    expect(compactCount(73_263)).toBe('73,263');
    expect(formatChange(19.55)).toBe('19.55%');
    expect(formatChange(-3.39)).toBe('-3.39%');
    expect(formatChange(2392)).toBe('2,392%');
    expect(formatChange(354_000)).toBe('354K%');
    expect(formatChange(null)).toBe('–');
    expect(formatAge(3 * 60_000)).toBe('3m');
    expect(formatAge(7 * 3_600_000)).toBe('7h');
    expect(formatAge(11 * 86_400_000)).toBe('11d');
    expect(formatAge(800 * 86_400_000)).toBe('2y');
    expect(formatAge(null)).toBe('–');
  });
});

const row = (symbol: string, over: Partial<MarketRow> = {}): MarketRow => ({ chain: 'solana', address: symbol.padEnd(32, 'A'), symbol, quoteSymbol: 'SOL', name: symbol, icon: null, decimals: 6, pool: 'P'.repeat(32), priceUsd: 1, capUsd: 100, ageMs: 1000, txns24h: 10, volume24hUsd: 5, traders24h: 3, change: { m5: 0, h1: 0, h6: 0, h24: 0 }, liquidityUsd: 50, risk: null, fresh: false, ...over });

describe('sorting', () => {
  it('sorts by a column either way and always puts missing values last', () => {
    const rows = [row('A', { capUsd: 5 }), row('B', { capUsd: null }), row('C', { capUsd: 20 }), row('D', { capUsd: 1 })];
    expect(sortRows(rows, 'cap', 'desc').map((r) => r.symbol)).toEqual(['C', 'A', 'D', 'B']);
    expect(sortRows(rows, 'cap', 'asc').map((r) => r.symbol)).toEqual(['D', 'A', 'C', 'B']);
    expect(sortRows(rows, 'h24', 'desc').map((r) => r.symbol)).toEqual(['A', 'B', 'C', 'D']); // all equal: original order kept
  });

  it('property: it loses nothing, changes nothing it was given, and is ordered', () => {
    fc.assert(fc.property(fc.array(fc.option(fc.double({ noNaN: true, min: -1e6, max: 1e6 }), { nil: null }), { maxLength: 30 }), fc.constantFrom('asc' as const, 'desc' as const), (vals, dir) => {
      const rows = vals.map((v, i) => row(`T${i}`, { liquidityUsd: v }));
      const before = rows.map((r) => r.symbol).join();
      const out = sortRows(rows, 'liquidity', dir);
      const known = out.filter((r) => r.liquidityUsd !== null).map((r) => r.liquidityUsd!);
      const ordered = known.every((v, i) => i === 0 || (dir === 'asc' ? known[i - 1]! <= v : known[i - 1]! >= v));
      const nullsLast = out.map((r) => r.liquidityUsd === null).join().includes('true,false') === false;
      return out.length === rows.length && rows.map((r) => r.symbol).join() === before && ordered && nullsLast;
    }));
  });
});

const pool = (over: Record<string, unknown> = {}, tokenOver: Record<string, unknown> = {}, network = 'solana') => ({
  data: [{ attributes: { name: 'PEPE / SOL 0.3%', address: 'Pool'.padEnd(32, 'x'), base_token_price_usd: '0.0000012', fdv_usd: '5000000', market_cap_usd: null, price_change_percentage: { m5: '0.5', h1: '-2', h6: '10', h24: '300' }, transactions: { h24: { buys: 60, sells: 40, buyers: 30, sellers: 20 } }, volume_usd: { h24: '250000' }, reserve_in_usd: '90000', pool_created_at: new Date(NOW - 3 * 3_600_000).toISOString(), ...over }, relationships: { network: { data: { id: network } }, base_token: { data: { id: `${network}_${MINT}` } } } }],
  included: [{ id: `${network}_${MINT}`, type: 'token', attributes: { address: MINT, name: 'Pepe', symbol: 'PEPE', decimals: 6, image_url: 'https://assets.geckoterminal.com/pepe.png', ...tokenOver } }],
});

describe('Marketplace rows from GeckoTerminal', () => {
  it('read every column of a pool, using fully diluted value when there is no market cap', () => {
    const [r] = parseGeckoPools(pool(), NOW);
    expect(r).toMatchObject({ chain: 'solana', symbol: 'PEPE', quoteSymbol: 'SOL', name: 'Pepe', decimals: 6, priceUsd: 0.0000012, capUsd: 5_000_000, txns24h: 100, traders24h: 50, volume24hUsd: 250_000, liquidityUsd: 90_000, change: { m5: 0.5, h1: -2, h6: 10, h24: 300 }, icon: 'https://assets.geckoterminal.com/pepe.png' });
    expect(r!.ageMs).toBe(3 * 3_600_000);
  });

  it('keep missing numbers as null, not zero, and skip abusive names, other networks and bad addresses', () => {
    const [r] = parseGeckoPools(pool({ transactions: {}, volume_usd: {}, price_change_percentage: {}, pool_created_at: undefined, base_token_price_usd: null }), NOW);
    expect(r).toMatchObject({ txns24h: null, volume24hUsd: null, traders24h: null, priceUsd: null, ageMs: null, change: { m5: null, h1: null, h6: null, h24: null } });
    expect(parseGeckoPools(pool({}, { symbol: 'FAGGOT' }), NOW)).toEqual([]);
    expect(parseGeckoPools(pool({}, {}, 'ton'), NOW)).toEqual([]);
    expect(parseGeckoPools(pool({}, { address: '0xnothex' }, 'base'), NOW)).toEqual([]);
    expect(parseGeckoPools(null, NOW)).toEqual([]);
    expect(parseGeckoPools({ data: 'x' }, NOW)).toEqual([]);
  });

  it('work out the network from the token id when the list does not name it, including networks whose id has an underscore', () => {
    const noNet = pool();
    delete (noNet.data[0]!.relationships as Record<string, unknown>).network;
    expect(parseGeckoPools(noNet, NOW)[0]!.chain).toBe('solana');
    const poly = pool({}, { address: '0x' + 'ab'.repeat(20) }, 'polygon_pos');
    delete (poly.data[0]!.relationships as Record<string, unknown>).network;
    expect(parseGeckoPools(poly, NOW)[0]!.chain).toBe('polygon');
  });

  it('hide a token whose name imitates another with look-alike letters', () => {
    expect(parseGeckoPools(pool({}, { symbol: 'ՍЅᎠТ', name: 'ՍЅᎠТ' }), NOW)).toEqual([]);
  });

  it('drop an unsafe picture link', () => {
    expect(parseGeckoPools(pool({}, { image_url: 'javascript:alert(1)' }), NOW)[0]!.icon).toBeNull();
  });
});

describe('the Marketplace loader', () => {
  const reply = (urls: string[], body: unknown = pool(), status = 200): typeof fetch => (async (u: string) => (urls.push(String(u)), new Response(JSON.stringify(body), { status }))) as unknown as typeof fetch;

  it('asks the right list for each view, with the chosen window', async () => {
    const urls: string[] = [];
    const m = new GeckoMarket(reply(urls), () => NOW);
    await m.load({ kind: 'trending', chain: '', window: 'h6' });
    await m.load({ kind: 'trending', chain: 'base', window: 'h1' });
    await m.load({ kind: 'new', chain: 'solana', window: 'h24' });
    expect(urls[0]).toContain('/networks/trending_pools?include=base_token&duration=6h');
    expect(urls[1]).toContain('/networks/base/trending_pools?include=base_token&duration=1h');
    expect(urls[2]).toContain('/networks/solana/new_pools');
  });

  it('builds Top and Gainers from the busiest pools of every network, and Gainers needs real liquidity and volume', async () => {
    const urls: string[] = [];
    const m = new GeckoMarket(reply(urls), () => NOW);
    const top = await m.load({ kind: 'top', chain: '', window: 'h24' });
    expect(urls.filter((u) => u.includes('sort=h24_volume_usd_desc'))).toHaveLength(9);
    expect(top.length).toBeGreaterThan(0);
    const thin = new GeckoMarket(reply([], pool({ reserve_in_usd: '500', volume_usd: { h24: '300' } })), () => NOW);
    expect(await thin.load({ kind: 'gainers', chain: 'solana', window: 'h24' })).toEqual([]);
  });

  it('shows one row per token, reuses a recent answer, and explains a busy or unreachable service', async () => {
    const urls: string[] = [];
    const m = new GeckoMarket(reply(urls), () => NOW);
    await m.load({ kind: 'new', chain: 'solana', window: 'h24' });
    await m.load({ kind: 'new', chain: 'solana', window: 'h24' });
    expect(urls).toHaveLength(1);
    const twice = { data: [...pool().data, ...pool().data], included: pool().included };
    expect(await new GeckoMarket(reply([], twice), () => NOW).load({ kind: 'new', chain: 'solana', window: 'h24' })).toHaveLength(1);
    await expect(new GeckoMarket(reply([], {}, 429), () => NOW).load({ kind: 'new', chain: 'solana', window: 'h24' })).rejects.toThrow(/busy/);
    await expect(new GeckoMarket((async () => { throw new Error('x'); }) as unknown as typeof fetch, () => NOW).load({ kind: 'new', chain: 'solana', window: 'h24' })).rejects.toThrow(/could not be reached/);
  });
});

const rec = (over: Partial<TokenRecord> = {}): TokenRecord => ({ ref: { chain: 'solana', address: MINT }, symbol: 'NEW', name: 'New one', decimals: 6, logo: null, firstDetectedAt: NOW - 600_000, discoverySource: 't', createdAt: null, firstPoolAt: NOW - 900_000, discoveryStatus: 'tradable', liquidityUsd: 1234, volume24hUsd: 55, holderCount: null, pools: [{ venue: 'v', address: 'Pool'.padEnd(32, 'x') }], metadata: {}, verified: false, metadataConfidence: 'api', risk: { status: 'elevated', score: 40, signals: [], assessedAt: 1, version: 1 } as never, updatedAt: NOW, ...over });
const dexPair = { chainId: 'solana', pairAddress: 'Pair'.padEnd(32, 'z'), baseToken: { address: MINT, symbol: 'NEW' }, quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, priceUsd: '0.5', marketCap: 80000, fdv: 90000, pairCreatedAt: NOW - 120_000, txns: { h24: { buys: 7, sells: 3 } }, volume: { h24: 4000 }, priceChange: { m5: 1, h1: 2, h6: 3, h24: 4 }, liquidity: { usd: 20000 }, info: { imageUrl: 'https://cdn.dexscreener.com/n.png' } };

describe('Find Tokens rows', () => {
  it('combine the registry\'s rating with DexScreener\'s numbers', () => {
    const r = rowFromRecord(rec(), [dexPair], NOW);
    expect(r).toMatchObject({ symbol: 'NEW', quoteSymbol: 'SOL', priceUsd: 0.5, capUsd: 80000, txns24h: 10, volume24hUsd: 4000, liquidityUsd: 20000, ageMs: 120_000, fresh: true, icon: 'https://cdn.dexscreener.com/n.png', change: { m5: 1, h1: 2, h6: 3, h24: 4 } });
    expect(r.risk).toEqual({ status: 'elevated', label: 'Elevated risk', score: 40 });
  });

  it('fall back to what the registry knows, with dashes for the rest, when DexScreener has nothing', () => {
    const r = rowFromRecord(rec(), [], NOW);
    expect(r).toMatchObject({ priceUsd: null, capUsd: null, txns24h: null, liquidityUsd: 1234, volume24hUsd: 55, ageMs: 900_000 });
    expect(r.change).toEqual({ m5: null, h1: null, h6: null, h24: null });
  });

  it('look up many tokens in batches of 30 per network, and survive a failing batch', async () => {
    const recs = Array.from({ length: 65 }, (_, i) => rec({ ref: { chain: 'solana', address: `T${i}`.padEnd(32, 'A') }, symbol: `S${i}` }));
    const f = vi.fn(async () => new Response('[]'));
    const rows = await rowsFromRecords(recs, f as unknown as typeof fetch, () => NOW);
    expect(rows).toHaveLength(65);
    expect(f).toHaveBeenCalledTimes(3);
    const down = await rowsFromRecords(recs.slice(0, 2), (async () => { throw new Error('offline'); }) as unknown as typeof fetch, () => NOW);
    expect(down).toHaveLength(2);
    expect(down[0]!.liquidityUsd).toBe(1234);
  });
});
