import { describe, expect, it, vi } from 'vitest';
import { GeckoPoolFinder, type PoolInfo } from '../charts/pool.js';
import { SwingsError } from '../core/types.js';
import { resolveRowPool } from './resolvePool.js';
import type { MarketRow } from './types.js';

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const POOL_A = 'A'.repeat(44);
const POOL_B = 'B'.repeat(44);

const bare = (over: Partial<MarketRow> = {}): MarketRow => ({
  chain: 'solana', address: MINT, symbol: 'RUSSIAINU', quoteSymbol: '', name: 'Russian Inu', icon: null, decimals: null, pool: '', priceUsd: null, capUsd: null, ageMs: null,
  txns24h: null, volume24hUsd: null, traders24h: null, change: { m5: null, h1: null, h6: null, h24: null }, liquidityUsd: null, risk: null, fresh: false, ...over,
});

const info = (over: Partial<PoolInfo> = {}): PoolInfo => ({ network: 'solana', pool: POOL_A, poolName: 'RUSSIAINU / SOL', priceUsd: 0.002, change24h: 4.5, volume24hUsd: 1000, liquidityUsd: 9000, trades24h: 10, ...over });

describe('resolving the pool of a token known only by its address', () => {
  it('puts the best pool on the row, with its quote coin and numbers', async () => {
    const find = vi.fn().mockResolvedValue(info());
    const res = await resolveRowPool(bare(), find);
    expect(find).toHaveBeenCalledWith('solana', MINT);
    expect(res.status).toBe('ready');
    expect(res.row.pool).toBe(POOL_A);
    expect(res.row.quoteSymbol).toBe('SOL');
    expect(res.row.priceUsd).toBe(0.002);
    expect(res.row.liquidityUsd).toBe(9000);
  });

  it('does not look anything up when the row already has a pool', async () => {
    const find = vi.fn();
    const row = bare({ pool: POOL_B });
    const res = await resolveRowPool(row, find);
    expect(find).not.toHaveBeenCalled();
    expect(res).toEqual({ status: 'ready', row });
  });

  it('reports no pool, not an error, when none exists yet', async () => {
    const res = await resolveRowPool(bare(), () => Promise.reject(new SwingsError('no-route', 'No trading pool was found for this token.')));
    expect(res.status).toBe('none');
    expect(res.row.pool).toBe('');
  });

  it('reports a failed lookup apart from having no pool', async () => {
    const res = await resolveRowPool(bare(), () => Promise.reject(new SwingsError('provider-failed', 'The price service is busy. Try again in a minute.')));
    expect(res).toMatchObject({ status: 'failed', message: 'The price service is busy. Try again in a minute.' });
  });

  it('with the real finder: the deepest real pool beats a thinner or made-up pair, and an empty answer is no pool', async () => {
    const pool = (address: string, liq: string, quote: string) => ({
      attributes: { address, name: `RUSSIAINU / ${quote}`, reserve_in_usd: liq, base_token_price_usd: '0.002' },
      relationships: { base_token: { data: { id: `solana_${MINT}` } }, quote_token: { data: { id: `solana_${quote}` } } },
    });
    const body = { data: [pool('C'.repeat(44), '50', 'Fake1111111111111111111111111111111111111'), pool(POOL_B, '90000', 'So11111111111111111111111111111111111111112')] };
    const ok = new GeckoPoolFinder(async () => new Response(JSON.stringify(body)));
    const got = await resolveRowPool(bare(), (c, a) => ok.find(c, a));
    expect(got.status).toBe('ready');
    expect(got.row.pool).toBe(POOL_B);

    const empty = new GeckoPoolFinder(async () => new Response(JSON.stringify({ data: [] })));
    expect((await resolveRowPool(bare(), (c, a) => empty.find(c, a))).status).toBe('none');
    const missing = new GeckoPoolFinder(async () => new Response('{}', { status: 404 }));
    expect((await resolveRowPool(bare(), (c, a) => missing.find(c, a))).status).toBe('none');
  });
});
