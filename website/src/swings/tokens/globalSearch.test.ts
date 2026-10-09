import { describe, expect, it } from 'vitest';
import { mergeHits, parseGeckoSearch, parseRegistrySearch, searchTokens, type SearchHit } from './globalSearch.js';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const EVM = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

const gecko = (rows: { network: string; token: string; address: string; symbol: string; name: string; reserve?: string; decimals?: number }[]) => ({
  data: rows.map((r) => ({ attributes: { reserve_in_usd: r.reserve ?? '1000', base_token_price_usd: '0.5' }, relationships: { network: { data: { id: r.network } }, base_token: { data: { id: r.token } } } })),
  included: rows.map((r) => ({ id: r.token, type: 'token', attributes: { address: r.address, symbol: r.symbol, name: r.name, decimals: r.decimals ?? 6, image_url: 'https://assets.geckoterminal.com/x.png' } })),
});

describe('GeckoTerminal search results', () => {
  it('become tokens on the networks Swings supports, with the pool liquidity', () => {
    const hits = parseGeckoSearch(gecko([{ network: 'solana', token: `solana_${BONK}`, address: BONK, symbol: 'Bonk', name: 'Bonk', reserve: '5000000', decimals: 5 }, { network: 'base', token: `base_${EVM}`, address: EVM, symbol: 'USDC', name: 'USD Coin' }]));
    expect(hits.map((h) => [h.chain, h.symbol, h.decimals])).toEqual([['solana', 'Bonk', 5], ['base', 'USDC', 6]]);
    expect(hits[0]!.liquidityUsd).toBe(5_000_000);
  });

  it('read the real answer shape, where a pool names no network and only the token id says which one', () => {
    const body = {
      data: [{ attributes: { reserve_in_usd: '900', base_token_price_usd: '1' }, relationships: { base_token: { data: { id: `solana_${BONK}`, type: 'token' } }, quote_token: { data: { id: 'solana_So11111111111111111111111111111111111111112' } }, dex: { data: { id: 'orca' } } } }],
      included: [{ id: `solana_${BONK}`, type: 'token', attributes: { address: BONK, name: 'Bonk', symbol: 'Bonk', decimals: 5, image_url: null } }],
    };
    expect(parseGeckoSearch(body).map((h) => [h.chain, h.symbol])).toEqual([['solana', 'Bonk']]);
  });

  it('skip networks Swings does not support, malformed addresses, abusive names and missing tokens', () => {
    const hits = parseGeckoSearch(gecko([
      { network: 'ton', token: 'ton_x', address: 'EQabc'.repeat(8), symbol: 'TON', name: 'Ton' },
      { network: 'base', token: 'base_bad', address: '0xnothex', symbol: 'BAD', name: 'Bad' },
      { network: 'solana', token: `solana_${BONK}`, address: BONK, symbol: 'FAGGOT', name: 'x' },
      { network: 'solana', token: `solana_${BONK}b`, address: BONK, symbol: 'OK', name: 'Fine' },
    ]));
    expect(hits.map((h) => h.symbol)).toEqual(['OK']);
    expect(parseGeckoSearch(null)).toEqual([]);
    expect(parseGeckoSearch({ data: 'nope' })).toEqual([]);
  });

  it('keep only https picture links', () => {
    const body = gecko([{ network: 'solana', token: `solana_${BONK}`, address: BONK, symbol: 'OK', name: 'Fine' }]);
    (body.included[0]!.attributes as { image_url: string }).image_url = 'javascript:alert(1)';
    expect(parseGeckoSearch(body)[0]!.icon).toBeNull();
  });
});

describe('registry search results', () => {
  it('become fresh tokens with their risk label, and never include a masked or abusive one', () => {
    const hits = parseRegistrySearch({ results: [
      { record: { ref: { chain: 'solana', address: BONK }, symbol: 'NEW', name: 'New one', logo: null, decimals: 6, liquidityUsd: 100, risk: { status: 'elevated' } } },
      { record: { ref: { chain: 'solana', address: BONK + 'x' }, symbol: '[hidden]', name: 'Name hidden because it is abusive' } },
      { record: { ref: { chain: 'dogechain', address: 'x' }, symbol: 'DOGE', name: '' } },
    ] });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ symbol: 'NEW', fresh: true, risk: 'elevated' });
  });
});

describe('merging', () => {
  const h = (over: Partial<SearchHit>): SearchHit => ({ chain: 'solana', address: BONK, symbol: 'A', name: 'A', icon: null, decimals: 6, liquidityUsd: 10, priceUsd: null, fresh: false, risk: null, ...over });

  it('shows a token found in both places once, marked new, with the registry\'s risk label and the larger pool', () => {
    const merged = mergeHits([h({ fresh: true, risk: 'high', liquidityUsd: 5 })], [h({ liquidityUsd: 900, icon: 'https://x/y.png' })]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ fresh: true, risk: 'high', liquidityUsd: 900, icon: 'https://x/y.png' });
  });

  it('ranks by liquidity, treats EVM addresses case-insensitively, and caps the list', () => {
    const many = Array.from({ length: 15 }, (_, i) => h({ address: `${BONK}${i}`, liquidityUsd: i }));
    const merged = mergeHits([], many);
    expect(merged).toHaveLength(10);
    expect(merged[0]!.liquidityUsd).toBe(14);
    const dup = mergeHits([], [h({ chain: 'base', address: EVM }), h({ chain: 'base', address: EVM.toUpperCase().replace('0X', '0x') })]);
    expect(dup).toHaveLength(1);
  });
});

describe('searchTokens', () => {
  const reply = (urls: string[], registry: unknown, geckoBody: unknown, down = false): typeof fetch => (async (url: string) => {
    urls.push(String(url));
    if (down && String(url).includes('geckoterminal')) throw new Error('offline');
    return new Response(JSON.stringify(String(url).includes('swings-tokens') ? registry : geckoBody));
  }) as unknown as typeof fetch;

  it('asks both sources and merges them', async () => {
    const urls: string[] = [];
    const hits = await searchTokens('bonk', reply(urls, { results: [{ record: { ref: { chain: 'solana', address: BONK }, symbol: 'BONK', name: 'Bonk', decimals: 5, liquidityUsd: 10 } }] }, gecko([{ network: 'solana', token: `solana_${BONK}`, address: BONK, symbol: 'Bonk', name: 'Bonk', reserve: '999' }])));
    expect(urls.some((u) => u.startsWith('/api/swings-tokens?q=bonk'))).toBe(true);
    expect(urls.some((u) => u.includes('geckoterminal') && u.includes('query=bonk'))).toBe(true);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.fresh).toBe(true);
  });

  it('still answers from one source when the other is down, and does not even ask for too-short or abusive text', async () => {
    const urls: string[] = [];
    const hits = await searchTokens('bonk', reply(urls, { results: [{ record: { ref: { chain: 'solana', address: BONK }, symbol: 'BONK', name: 'Bonk', decimals: 5 } }] }, {}, true));
    expect(hits.map((x) => x.symbol)).toEqual(['BONK']);
    const none: string[] = [];
    expect(await searchTokens('a', reply(none, {}, {}))).toEqual([]);
    expect(await searchTokens('faggot', reply(none, {}, {}))).toEqual([]);
    expect(none).toEqual([]);
  });
});
