import { beforeEach, describe, expect, it } from 'vitest';
import { capsFromPairs, fetchMissingCaps, knownCap, resetCapCache } from './walletMarketCap';

const A = '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const row = (chain: 'bnb' | 'solana', address: string, capUsd: number | null = null) => ({ chain, address, capUsd });
const pair = (address: string, over: Record<string, unknown> = {}) => ({ baseToken: { address }, liquidity: { usd: 1000 }, marketCap: 500, fdv: 900, ...over });

beforeEach(() => resetCapCache());

describe('capsFromPairs', () => {
  it('takes the market cap from the pair with the most liquidity, and the fully diluted value when there is no market cap', () => {
    const got = capsFromPairs([pair(A, { liquidity: { usd: 10 }, marketCap: 1 }), pair(A, { liquidity: { usd: 5000 }, marketCap: 700 }), pair(B, { marketCap: undefined, fdv: 42 })], 'bnb');
    expect(got.get(A.toLowerCase())).toEqual({ capUsd: 700, isFdv: false });
    expect(got.get(B)).toEqual({ capUsd: 42, isFdv: true });
  });

  it('ignores junk: no figure, zero, negative, above a trillion, or not a list', () => {
    expect(capsFromPairs([pair(A, { marketCap: 0, fdv: 0 }), pair(B, { marketCap: 5e12, fdv: -1 }), { nothing: true }, null], 'bnb').size).toBe(0);
    expect(capsFromPairs({ pairs: [] }, 'bnb').size).toBe(0);
  });

  it('keeps a Solana address as it is written', () => {
    expect(capsFromPairs([pair('AbC123')], 'solana').get('AbC123')).toEqual({ capUsd: 500, isFdv: false });
  });
});

describe('fetchMissingCaps', () => {
  it('asks only for rows without a cap, 30 tokens to a request, and finds them', async () => {
    const urls: string[] = [];
    const many = Array.from({ length: 65 }, (_, i) => row('bnb', `0x${i.toString(16).padStart(40, '0')}`));
    const f = (async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify([pair(many[0]!.address, { marketCap: 123 })]), { status: 200 });
    }) as unknown as typeof fetch;
    const got = await fetchMissingCaps([...many, row('bnb', B, 99)], { fetchImpl: f });
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('/tokens/v1/bsc/');
    expect(urls.join(' ')).not.toContain(B);
    expect(got.get(`bnb:${many[0]!.address.toLowerCase()}`)).toEqual({ capUsd: 123, isFdv: false });
  });

  it('remembers an answer, so the same card is not asked twice, and the row can look it up', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify([pair(A, { marketCap: 77 })]), { status: 200 });
    }) as unknown as typeof fetch;
    await fetchMissingCaps([row('bnb', A)], { fetchImpl: f });
    await fetchMissingCaps([row('bnb', A)], { fetchImpl: f });
    expect(calls).toBe(1);
    expect(knownCap(row('bnb', A))).toEqual({ capUsd: 77, isFdv: false });
    expect(knownCap(row('bnb', A, 5))).toBeNull();
  });

  it('pauses a network that says too many requests, and never throws', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response('', { status: 429 });
    }) as unknown as typeof fetch;
    expect((await fetchMissingCaps([row('bnb', A)], { fetchImpl: f })).size).toBe(0);
    await fetchMissingCaps([row('bnb', B)], { fetchImpl: f });
    expect(calls).toBe(1);
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    resetCapCache();
    await expect(fetchMissingCaps([row('solana', 'So1')], { fetchImpl: down })).resolves.toEqual(new Map());
  });
});
