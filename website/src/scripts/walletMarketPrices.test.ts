import { beforeEach, describe, expect, it } from 'vitest';
import { fetchLivePrices, pricesFromPairs, resetPricePauses } from './walletMarketPrices';

const A = '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const pair = (address: string, over: Record<string, unknown> = {}) => ({ baseToken: { address }, priceUsd: '0.5', liquidity: { usd: 1000 }, priceChange: { m5: 1, h1: 2, h6: 3, h24: 4 }, ...over });

beforeEach(() => resetPricePauses());

describe('pricesFromPairs', () => {
  it('takes the price and the changes from the most liquid pair of each token', () => {
    const got = pricesFromPairs([pair(A, { priceUsd: '1', liquidity: { usd: 5 } }), pair(A, { priceUsd: '2', liquidity: { usd: 900 }, priceChange: { h1: 9 } })], 'bnb');
    expect(got.get(A.toLowerCase())).toEqual({ priceUsd: 2, change: { h1: 9 } });
  });

  it('skips a pair with no usable price, keeps a Solana address as written, and ignores a non-list', () => {
    expect(pricesFromPairs([pair(A, { priceUsd: '0' }), pair(B, { priceUsd: 'x' }), { nothing: 1 }], 'bnb').size).toBe(0);
    expect(pricesFromPairs([pair('SoLaNa1')], 'solana').has('SoLaNa1')).toBe(true);
    expect(pricesFromPairs({ pairs: [] }, 'bnb').size).toBe(0);
  });
});

describe('fetchLivePrices', () => {
  it('sends one request per 30 tokens of a network, and returns the prices by row key', async () => {
    const urls: string[] = [];
    const tokens = Array.from({ length: 31 }, (_, i) => ({ chain: 'bnb' as const, address: `0x${i.toString(16).padStart(40, '0')}` }));
    const f = (async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify([pair(tokens[0]!.address, { priceUsd: '7' })]), { status: 200 });
    }) as unknown as typeof fetch;
    const got = await fetchLivePrices(tokens, { fetchImpl: f });
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('/tokens/v1/bsc/');
    expect(got.get(`bnb:${tokens[0]!.address}`)?.priceUsd).toBe(7);
  });

  it('pauses a network that says too many requests, and never throws', async () => {
    let calls = 0;
    const tooMany = (async () => {
      calls++;
      return new Response('', { status: 429 });
    }) as unknown as typeof fetch;
    expect((await fetchLivePrices([{ chain: 'bnb', address: A }], { fetchImpl: tooMany })).size).toBe(0);
    await fetchLivePrices([{ chain: 'bnb', address: B }], { fetchImpl: tooMany });
    expect(calls).toBe(1);
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    resetPricePauses();
    await expect(fetchLivePrices([{ chain: 'solana', address: 'So1' }], { fetchImpl: down })).resolves.toEqual(new Map());
  });
});
