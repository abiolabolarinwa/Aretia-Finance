import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimit } from './_rpcProxy.js';
import { handleTrades, resetTradesCache } from './_swingsTrades.js';

const POOL = '0x124fCfd1B923485C8cCf275AFbEe4bf557B232D6';
const TX = '0xca405963804bb9eb745dc1e5a5f2ed6ac249d0e23f262c01f14e6d5c700d2b39';
const WHO = '0xc18e0270177141ae65d992950e4a1d3394d08621';
const NOW = 1_800_000_000_000;
const row = (over: Record<string, unknown> = {}) => ({ attributes: { block_timestamp: '2026-10-12T21:25:56Z', tx_hash: TX, tx_from_address: WHO, kind: 'sell', from_token_amount: '34.7', to_token_amount: '12.7', price_from_in_usd: '0.37', price_to_in_usd: '1.0', volume_in_usd: '12.7', ...over } });
const upstream = (data: unknown[] = [row()], status = 200): typeof fetch => vi.fn(async () => new Response(JSON.stringify({ data }), { status })) as unknown as typeof fetch;
const input = (query: Record<string, string>, fetchImpl: typeof fetch, now = NOW, ip = '3.3.3.3') => ({ method: 'GET', origin: null, authorization: null, ip, query, env: {}, fetchImpl, now });
const q = (over: Record<string, string> = {}) => ({ chain: 'polygon', pool: POOL, ...over });
const calls = (f: typeof fetch) => (f as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => new URL(String(c[0])));

describe('shared trades for the Transactions table', () => {
  beforeEach(() => {
    resetRateLimit();
    resetTradesCache(0);
  });

  it('asks the right network and pool, and returns cleaned rows', async () => {
    const f = upstream();
    const out = await handleTrades(input(q(), f));
    const u = calls(f)[0]!;
    expect(u.origin + u.pathname).toBe(`https://api.geckoterminal.com/api/v2/networks/polygon_pos/pools/${POOL}/trades`);
    expect(out.status).toBe(200);
    const body = JSON.parse(out.body);
    expect(body.stale).toBe(false);
    expect(body.trades).toEqual([{ t: Date.parse('2026-10-12T21:25:56Z'), kind: 'sell', usd: 12.7, tokenAmount: 34.7, quoteAmount: 12.7, priceUsd: 0.37, trader: WHO, tx: TX }]);
  });

  it('shows the second token from its own point of view when asked to', async () => {
    const out = await handleTrades(input(q({ token: 'quote' }), upstream()));
    expect(JSON.parse(out.body).trades[0]).toMatchObject({ kind: 'buy', tokenAmount: 12.7, quoteAmount: 34.7, priceUsd: 1 });
  });

  it('drops malformed rows before they reach a browser', async () => {
    const out = await handleTrades(input(q(), upstream([row({ tx_hash: 'javascript:alert(1)' }), row({ kind: 'x' }), row()])));
    expect(JSON.parse(out.body).trades).toHaveLength(1);
  });

  it('serves many visitors from one upstream request, and lets the CDN keep the answer', async () => {
    const f = upstream();
    const a = await handleTrades(input(q(), f));
    const b = await handleTrades(input(q(), f, NOW + 2_000, '4.4.4.4'));
    expect(calls(f)).toHaveLength(1);
    expect(a.headers['cache-control']).toBe('public, s-maxage=3, stale-while-revalidate=6');
    expect(JSON.parse(b.body).stale).toBe(false);
    // Once the answer is old it is asked for again.
    await handleTrades(input(q(), f, NOW + 4_000));
    expect(calls(f)).toHaveLength(2);
  });

  it('keeps the two tokens of a pool apart, and EVM addresses case-insensitively', async () => {
    const f = upstream();
    await handleTrades(input(q(), f));
    await handleTrades(input(q({ token: 'quote' }), f));
    await handleTrades(input(q({ pool: POOL.toLowerCase() }), f));
    // base, quote, and the lower-case spelling of the same pool as the first.
    expect(calls(f)).toHaveLength(2);
  });

  it('shares one upstream request between visitors who ask at the same moment', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const f = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ data: [row()] }));
    }) as unknown as typeof fetch;
    const both = Promise.all([handleTrades(input(q(), f)), handleTrades(input(q(), f, NOW, '5.5.5.5'))]);
    release();
    const [a, b] = await both;
    expect(calls(f)).toHaveLength(1);
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it('tries the source once more when it refuses for a moment', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 429 })).mockResolvedValue(new Response(JSON.stringify({ data: [row()] })));
    const out = await handleTrades(input(q(), f as unknown as typeof fetch));
    expect(out.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('returns the last good trades, marked old, when the source fails; and an error when it never answered', async () => {
    await handleTrades(input(q(), upstream()));
    const refused = upstream([], 429);
    const out = await handleTrades(input(q(), refused, NOW + 2 * 60_000));
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body).stale).toBe(true);
    expect(out.headers['cache-control']).toBe('no-store');
    resetTradesCache(0);
    expect((await handleTrades(input(q(), refused))).status).toBe(502);
  });

  it('treats an unknown pool as an empty list', async () => {
    const out = await handleTrades(input(q(), upstream([], 404)));
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body).trades).toEqual([]);
  });

  it('refuses requests it cannot serve, without calling the source', async () => {
    const never = upstream();
    const cases: Record<string, string>[] = [{ chain: 'mars' }, { pool: '../../x' }, { pool: 'short' }, { token: 'both' }, { chain: '' }];
    for (const bad of cases) expect((await handleTrades(input(q(bad), never))).status).toBe(400);
    expect((await handleTrades({ ...input(q(), never), method: 'POST' })).status).toBe(405);
    expect(calls(never)).toHaveLength(0);
  });

  it("serves a busy visitor from what it already has, and says so plainly when it has nothing", async () => {
    const f = upstream();
    await handleTrades(input(q(), f));
    let last = { status: 0 };
    for (let i = 0; i < 125; i++) last = await handleTrades(input(q({ pool: `${POOL.slice(0, 40)}${String(i).padStart(2, '0')}` }), upstream(), NOW, '6.6.6.6'));
    expect(last.status).toBe(429);
    const warm = await handleTrades(input(q(), f, NOW + 30_000, '6.6.6.6'));
    expect(warm.status).toBe(200);
    expect(JSON.parse(warm.body).stale).toBe(true);
  });
});
