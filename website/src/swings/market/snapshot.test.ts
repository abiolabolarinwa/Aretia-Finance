import { describe, expect, it } from 'vitest';
import type { TokenRecord } from '../core/types.js';
import { InMemoryTokenRepository, TokenRegistryService } from '../tokens/registry.js';
import { rowFromRecord, rowsFromRecords } from './registryRows.js';
import { isFresh, marketFromAttributes, refreshSnapshots, SNAPSHOT_FRESH_MS } from './snapshot.js';

const NOW = 1_800_000_000_000;
const POOL = 'Pool1111111111111111111111111111111111111111';
const attrs = { address: POOL, base_token_price_usd: '0.5', fdv_usd: '1000', market_cap_usd: null, reserve_in_usd: '5000', volume_usd: { h24: '700' }, transactions: { h24: { buys: 3, sells: 4 } }, price_change_percentage: { m5: '1', h1: '-2', h6: '3', h24: '4' } };
const ref = { chain: 'solana' as const, address: 'So11111111111111111111111111111111111111112' };

describe('market snapshot', () => {
  it('reads pool attributes, and gives nothing when there is no price', () => {
    const m = marketFromAttributes(attrs, POOL, NOW)!;
    expect(m).toMatchObject({ at: NOW, priceUsd: 0.5, capUsd: 1000, txns24h: 7, volume24hUsd: 700, liquidityUsd: 5000, change: { m5: 1, h1: -2, h6: 3, h24: 4 } });
    expect(marketFromAttributes({ ...attrs, base_token_price_usd: null }, POOL, NOW)).toBeNull();
  });

  it('is fresh only inside the window', () => {
    const m = marketFromAttributes(attrs, POOL, NOW)!;
    expect(isFresh(m, NOW + SNAPSHOT_FRESH_MS - 1)).toBe(true);
    expect(isFresh(m, NOW + SNAPSHOT_FRESH_MS)).toBe(false);
    expect(isFresh(null, NOW)).toBe(false);
  });

  it('a fresh snapshot makes a row without any outside request', async () => {
    const repo = new InMemoryTokenRepository();
    const reg = new TokenRegistryService(repo, () => NOW);
    const rec = (await reg.ingest({ ref, symbol: 'AAA', name: 'Aaa', decimals: 6, firstPoolAt: NOW - 3_600_000, pool: { venue: 'x', address: POOL }, market: marketFromAttributes(attrs, POOL, NOW) , source: 't' }))!;
    let calls = 0;
    const rows = await rowsFromRecords([rec], (async () => { calls++; return new Response('[]'); }) as typeof fetch, () => NOW + 60_000);
    expect(calls).toBe(0);
    expect(rows[0]).toMatchObject({ symbol: 'AAA', priceUsd: 0.5, volume24hUsd: 700, txns24h: 7, pool: POOL, ageMs: 3_600_000 + 60_000 });
  });

  it('a stale snapshot falls back to the outside lookup', async () => {
    const stale: TokenRecord = { ...(await new TokenRegistryService(new InMemoryTokenRepository(), () => NOW).ingest({ ref, symbol: 'AAA', source: 't' }))!, market: marketFromAttributes(attrs, POOL, NOW)! };
    let calls = 0;
    await rowsFromRecords([stale], (async () => { calls++; return new Response('[]'); }) as typeof fetch, () => NOW + SNAPSHOT_FRESH_MS + 1);
    expect(calls).toBe(1);
    expect(rowFromRecord(stale, [], NOW + SNAPSHOT_FRESH_MS + 1).priceUsd).toBeNull();
  });

  it('refreshes the stalest tokens in one request and saves what it gets', async () => {
    const repo = new InMemoryTokenRepository();
    const reg = new TokenRegistryService(repo, () => NOW);
    const rec = (await reg.ingest({ ref, symbol: 'AAA', pool: { venue: 'x', address: POOL }, source: 't' }))!;
    const urls: string[] = [];
    const fetchImpl = (async (u: string) => { urls.push(u); return new Response(JSON.stringify({ data: [{ attributes: attrs }] })); }) as unknown as typeof fetch;
    const out = await refreshSnapshots('solana', [rec], (r, m) => reg.setMarket(r.ref, m), fetchImpl, NOW);
    expect(out).toEqual({ asked: 1, updated: 1, error: null });
    expect(urls).toHaveLength(1);
    expect((await repo.get(ref))!.market?.priceUsd).toBe(0.5);
    const failed = await refreshSnapshots('solana', [rec], async () => undefined, (async () => new Response('', { status: 429 })) as typeof fetch, NOW);
    expect(failed.error).toMatch(/429/);
  });
});
