import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRateLimit } from './_rpcProxy.js';
import { handleOhlcv, resetOhlcvCache } from './_swingsOhlcv.js';

const POOL = '0x124fCfd1B923485C8cCf275AFbEe4bf557B232D6';
const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;
// Newest first, as GeckoTerminal sends them.
const LIST = [[1_799_999_100, 3, 4, 2, 3.5, 30], [1_799_998_200, 2, 3, 1, 2.5, 20]];
const upstream = (list: unknown = LIST, status = 200): typeof fetch => vi.fn(async () => new Response(JSON.stringify({ data: { attributes: { ohlcv_list: list } } }), { status })) as unknown as typeof fetch;
const input = (query: Record<string, string>, fetchImpl: typeof fetch, now = NOW, ip = '3.3.3.3') => ({ method: 'GET', origin: null, authorization: null, ip, query, env: {}, fetchImpl, now });
const q = (over: Record<string, string> = {}) => ({ chain: 'polygon', pool: POOL, tf: 'minute', agg: '15', before: String(NOW_S + 900), limit: '300', ...over });
const calls = (f: typeof fetch) => (f as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => new URL(String(c[0])));

describe('shared candles for the chart', () => {
  beforeEach(() => {
    resetRateLimit();
    resetOhlcvCache(0);
  });

  it('tries the source once more when it refuses for a moment, before giving up', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 429 })).mockResolvedValue(new Response(JSON.stringify({ data: { attributes: { ohlcv_list: LIST } } })));
    const out = await handleOhlcv(input(q(), f as unknown as typeof fetch));
    expect(out.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
    resetOhlcvCache(0);
    const down = vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    expect((await handleOhlcv(input(q(), down))).status).toBe(502);
    expect(down).toHaveBeenCalledTimes(2);
  });

  it('asks the right network, pool and size once, and returns the candles the page already knows how to read', async () => {
    const f = upstream();
    const out = await handleOhlcv(input(q(), f));
    const u = calls(f)[0]!;
    expect(u.origin + u.pathname).toBe(`https://api.geckoterminal.com/api/v2/networks/polygon_pos/pools/${POOL}/ohlcv/minute`);
    expect(u.searchParams.get('aggregate')).toBe('15');
    expect(u.searchParams.get('limit')).toBe('300');
    expect(u.searchParams.get('token')).toBe('base');
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toEqual({ data: { attributes: { ohlcv_list: LIST } }, stale: false });
  });

  it('serves many visitors from one upstream request, even when their timestamps differ by a few seconds', async () => {
    const f = upstream();
    const a = await handleOhlcv(input(q({ before: String(NOW_S + 900) }), f));
    const b = await handleOhlcv(input(q({ before: String(NOW_S + 897) }), f, NOW + 5_000, '4.4.4.4'));
    expect(calls(f)).toHaveLength(1);
    expect(a.headers['cache-control']).toBe('public, s-maxage=20, stale-while-revalidate=40');
    expect(JSON.parse(b.body).stale).toBe(false);
  });

  it('keeps past candles longer than the live one, and asks again when the live answer is old', async () => {
    const f = upstream();
    const past = await handleOhlcv(input(q({ before: String(NOW_S - 100_000) }), f));
    expect(past.headers['cache-control']).toContain('s-maxage=600');
    await handleOhlcv(input(q(), f));
    await handleOhlcv(input(q(), f, NOW + 30_000));
    // One for the past answer, one for the live one, and one more once the live one went stale.
    expect(calls(f)).toHaveLength(3);
  });

  it('never looks further than one candle into the future', async () => {
    const f = upstream();
    await handleOhlcv(input(q({ before: String(NOW_S + 10_000_000) }), f));
    expect(Number(calls(f)[0]!.searchParams.get('before_timestamp'))).toBeLessThanOrEqual(NOW_S + 900 + 900);
  });

  it('shares one upstream request between visitors who ask at the same moment', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const f = vi.fn(async () => {
      await gate;
      return new Response(JSON.stringify({ data: { attributes: { ohlcv_list: LIST } } }));
    }) as unknown as typeof fetch;
    const both = Promise.all([handleOhlcv(input(q(), f)), handleOhlcv(input(q(), f, NOW, '5.5.5.5'))]);
    release();
    const [a, b] = await both;
    expect(calls(f)).toHaveLength(1);
    expect([a.status, b.status]).toEqual([200, 200]);
  });

  it('returns the last good candles, marked old, when the source refuses; and an error when it never answered', async () => {
    const good = upstream();
    await handleOhlcv(input(q(), good));
    const refused = upstream({}, 429);
    const out = await handleOhlcv(input(q(), refused, NOW + 5 * 60_000));
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body).stale).toBe(true);
    expect(out.headers['cache-control']).toBe('no-store');
    resetOhlcvCache();
    expect((await handleOhlcv(input(q(), refused))).status).toBe(502);
  });

  it('treats an unknown pool as an empty chart, and drops malformed candles', async () => {
    expect(JSON.parse((await handleOhlcv(input(q(), upstream({}, 404)))).body).data.attributes.ohlcv_list).toEqual([]);
    resetOhlcvCache();
    const out = await handleOhlcv(input(q(), upstream([[1, 2, 3, 4, 5, 6], [1, 'x', 3, 4, 5, 6], [1, 2], 'nope'])));
    expect(JSON.parse(out.body).data.attributes.ohlcv_list).toEqual([[1, 2, 3, 4, 5, 6]]);
  });

  it('refuses requests it cannot serve, without calling the source', async () => {
    const never = upstream();
    const cases: Record<string, string>[] = [{ chain: 'mars' }, { pool: '../../x' }, { pool: 'short' }, { tf: 'week' }, { agg: '7' }, { tf: 'day', agg: '5' }, { token: 'both' }, { limit: '5000' }, { limit: '0' }, { before: '0' }, { before: 'x' }];
    for (const bad of cases) {
      expect((await handleOhlcv(input(q(bad), never))).status).toBe(400);
    }
    expect((await handleOhlcv({ ...input(q(), never), method: 'POST' })).status).toBe(405);
    expect(calls(never)).toHaveLength(0);
  });

  it('serves a busy visitor from what it already has, and says so plainly when it has nothing', async () => {
    const f = upstream();
    await handleOhlcv(input(q(), f));
    let last = { status: 0, body: '' };
    // Spend this visitor's allowance on other pools.
    for (let i = 0; i < 125; i++) last = await handleOhlcv(input(q({ pool: `${POOL.slice(0, 40)}${String(i).padStart(2, '0')}` }), upstream(), NOW, '6.6.6.6'));
    expect(last.status).toBe(429);
    const warm = await handleOhlcv(input(q(), f, NOW + 30_000, '6.6.6.6'));
    expect(warm.status).toBe(200);
    expect(JSON.parse(warm.body).stale).toBe(true);
  });
});
