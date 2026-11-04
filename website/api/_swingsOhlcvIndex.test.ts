import { beforeEach, describe, expect, it, vi } from 'vitest';

const miOhlcv = vi.fn();
vi.mock('./_marketIndexer.js', () => ({ miOhlcv: (...args: unknown[]) => miOhlcv(...args) }));

const { resetRateLimit } = await import('./_rpcProxy.js');
const { handleOhlcv, resetOhlcvCache } = await import('./_swingsOhlcv.js');

const POOL = '0xC42C64A0F871Ea81787aC2DFa3709cf20c0AabaF';
const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;
const q = (over: Record<string, string> = {}) => ({ chain: 'base', pool: POOL, tf: 'minute', agg: '15', before: String(NOW_S + 900), limit: '300', ...over });
const input = (query: Record<string, string>, fetchImpl: typeof fetch) => ({ method: 'GET', origin: null, authorization: null, ip: '5.5.5.5', query, env: {}, fetchImpl, now: NOW });
const gecko = (status: number, list: unknown[] = []): typeof fetch => vi.fn(async () => new Response(JSON.stringify({ data: { attributes: { ohlcv_list: list } } }), { status })) as unknown as typeof fetch;
const indexAnswer = (rows: number[][]) => ({ status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, s-maxage=5' }, body: JSON.stringify({ data: { attributes: { ohlcv_list: rows } }, source: 'aretia-index', unit: 'usd-converted', reference: { pool: '0xe', label: 'WETH / USDC', price: 2253.1, at: NOW_S - 600 } }) });
const ROWS = [[NOW_S - 900, 1e-6, 2e-6, 1e-7, 1e-7, 3]];

describe('the candles endpoint falls back to Aretia\'s own index', () => {
  beforeEach(() => {
    resetRateLimit();
    resetOhlcvCache(0);
    miOhlcv.mockReset();
  });

  it('when GeckoTerminal refuses (429) and nothing was kept', async () => {
    miOhlcv.mockResolvedValue(indexAnswer(ROWS));
    const out = await handleOhlcv(input(q({ currency: 'usd' }), gecko(429)));
    expect(out.status).toBe(200);
    const body = JSON.parse(out.body);
    expect(body.source).toBe('aretia-index');
    expect(body.reference.label).toBe('WETH / USDC');
    expect(body.data.attributes.ohlcv_list).toEqual(ROWS);
  });

  it('when GeckoTerminal does not know the pool yet (404, a pool minutes old)', async () => {
    miOhlcv.mockResolvedValue(indexAnswer(ROWS));
    const out = await handleOhlcv(input(q(), gecko(404)));
    expect(JSON.parse(out.body).source).toBe('aretia-index');
  });

  it('but not when GeckoTerminal answers, and says which source answered', async () => {
    const out = await handleOhlcv(input(q(), gecko(200, [[NOW_S - 900, 1, 2, 1, 2, 5]])));
    expect(JSON.parse(out.body).source).toBe('geckoterminal');
    expect(miOhlcv).not.toHaveBeenCalled();
  });

  it('and answers an empty list or a clear error when the index has nothing either, never an invented answer', async () => {
    miOhlcv.mockResolvedValue({ status: 200, headers: {}, body: JSON.stringify({ data: { attributes: { ohlcv_list: [] } } }) });
    const empty = await handleOhlcv(input(q(), gecko(404)));
    expect(empty.status).toBe(200);
    expect(JSON.parse(empty.body).data.attributes.ohlcv_list).toEqual([]);
    resetOhlcvCache(0);
    miOhlcv.mockResolvedValue({ status: 404, headers: {}, body: '{"error":"unknown-pool"}' });
    const refused = await handleOhlcv(input(q({ before: String(NOW_S + 1800) }), gecko(429)));
    expect(refused.status).toBe(502);
    expect(JSON.parse(refused.body)).toEqual({ error: 'source', upstream: 429 });
  });

  it('and survives the index throwing', async () => {
    miOhlcv.mockRejectedValue(new Error('db down'));
    expect((await handleOhlcv(input(q(), gecko(429)))).status).toBe(502);
  });
});
