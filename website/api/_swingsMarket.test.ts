import { beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimit } from './_rpcProxy.js';
import { handleMarket, resetMarketCache } from './_swingsMarket.js';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const body = {
  data: [{ attributes: { address: 'Pool1111111111111111111111111111111111111111', name: 'Bonk / SOL', base_token_price_usd: '1', reserve_in_usd: '5000', volume_usd: { h24: '9' } }, relationships: { base_token: { data: { id: `solana_${BONK}` } } } }],
  included: [{ id: `solana_${BONK}`, type: 'token', attributes: { address: BONK, name: 'Bonk', symbol: 'Bonk', decimals: 5 } }],
};
const NOW = 1_800_000_000_000;
const input = (query: Record<string, string>, fetchImpl: typeof fetch, now = NOW) => ({ method: 'GET', origin: null, authorization: null, ip: '3.3.3.3', query, env: {}, fetchImpl, now });

describe('shared Marketplace lists', () => {
  beforeEach(() => {
    resetRateLimit();
    resetMarketCache();
  });

  it('fetches once for many visitors and lets the CDN keep the answer', async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
    const a = await handleMarket(input({ kind: 'top', chain: 'solana' }, f));
    const b = await handleMarket(input({ kind: 'top', chain: 'solana' }, f, NOW + 30_000));
    expect(calls).toBe(1);
    expect(JSON.parse(a.body).rows[0]).toMatchObject({ symbol: 'Bonk', chain: 'solana' });
    expect(JSON.parse(b.body).stale).toBe(false);
    expect(a.headers['cache-control']).toContain('s-maxage=60');
  });

  it('returns the last good list, marked stale, when the source refuses', async () => {
    const good = (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    await handleMarket(input({ kind: 'top', chain: 'solana' }, good));
    const refused = (async () => new Response('', { status: 429 })) as unknown as typeof fetch;
    const out = await handleMarket(input({ kind: 'top', chain: 'solana' }, refused, NOW + 5 * 60_000));
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toMatchObject({ stale: true });
    expect(out.headers['cache-control']).toBe('no-store');
    // nothing kept: an honest error, not an empty list
    resetMarketCache();
    expect((await handleMarket(input({ kind: 'top', chain: 'solana' }, refused))).status).toBe(502);
  });

  it('refuses nonsense and non-GET requests', async () => {
    const never = (async () => {
      throw new Error('no');
    }) as unknown as typeof fetch;
    expect((await handleMarket(input({ kind: 'nope' }, never))).status).toBe(400);
    expect((await handleMarket(input({ kind: 'top', chain: 'mars' }, never))).status).toBe(400);
    expect((await handleMarket(input({ kind: 'top', page: '99' }, never))).status).toBe(400);
    expect((await handleMarket({ ...input({}, never), method: 'POST' })).status).toBe(405);
  });
});
