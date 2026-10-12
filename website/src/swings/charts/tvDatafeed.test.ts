import { describe, expect, it, vi } from 'vitest';
import { createPoolDatafeed, parseBars, priceScaleFor, RESOLUTIONS, type TvBar } from './tvDatafeed.js';

const POOL = 'DopePool1111111111111111111111111111111111';
// Newest first, as GeckoTerminal sends them: [seconds, open, high, low, close, volume].
const LIST = [
  [1_700_001_800, 3, 4, 2, 3.5, 30],
  [1_700_000_900, 2, 3, 1, 2.5, 20],
  [1_700_000_000, 1, 2, 0.5, 1.5, 10],
];
const body = (list: unknown[]): unknown => ({ data: { attributes: { ohlcv_list: list } } });
const reply = (b: unknown, status = 200): typeof fetch => vi.fn(async () => new Response(JSON.stringify(b), { status })) as unknown as typeof fetch;

type Result = { bars: TvBar[]; noData: boolean } | { error: string };
function getBars(feed: ReturnType<typeof createPoolDatafeed>, resolution: string, params: { from: number; to: number; countBack?: number; firstDataRequest: boolean }): Promise<Result> {
  return new Promise((resolve) => {
    feed.getBars({} as never, resolution, params, (bars, meta) => resolve({ bars, noData: meta.noData }), (error) => resolve({ error }));
  });
}

describe('parseBars', () => {
  it('turns the newest-first list into oldest-first bars with times in milliseconds', () => {
    const bars = parseBars(body(LIST));
    expect(bars.map((b) => b.time)).toEqual([1_700_000_000_000, 1_700_000_900_000, 1_700_001_800_000]);
    expect(bars[0]).toEqual({ time: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
  });

  it('drops malformed, non-positive and impossible candles instead of drawing them', () => {
    const bars = parseBars(body([[1, 'x', 2, 1, 1, 1], [2, 0, 1, 1, 1, 1], [3, 1, 1, 2, 1, 1], [4, 1, 2, 1, 1.5], [5, 1, 2, 1, 1.5, 7], null, 'nope']));
    expect(bars.map((b) => b.time)).toEqual([5000]);
  });

  it('keeps one bar per time, and treats a missing volume as zero', () => {
    const bars = parseBars(body([[10, 1, 2, 1, 1.5, 'n/a'], [10, 1, 3, 1, 2, 5]]));
    expect(bars).toHaveLength(1);
    expect(parseBars(body([[10, 1, 2, 1, 1.5, 'n/a']]))[0]!.volume).toBe(0);
  });

  it('returns nothing for an answer of the wrong shape', () => {
    expect(parseBars(null)).toEqual([]);
    expect(parseBars({ data: {} })).toEqual([]);
    expect(parseBars({ data: { attributes: { ohlcv_list: 'x' } } })).toEqual([]);
  });
});

describe('priceScaleFor', () => {
  it('shows four significant digits from $60,000 coins down to tiny ones', () => {
    expect(priceScaleFor(60_000)).toBe(100);
    expect(priceScaleFor(1.23)).toBe(1e3);
    expect(priceScaleFor(0.0005877)).toBe(1e7);
    expect(priceScaleFor(4e-7)).toBe(1e10);
  });

  it('falls back to six decimals when the price is unknown', () => {
    expect(priceScaleFor(null)).toBe(1e6);
    expect(priceScaleFor(0)).toBe(1e6);
    expect(priceScaleFor(Number.NaN)).toBe(1e6);
  });
});

describe('the datafeed', () => {
  it('asks GeckoTerminal for the right network, pool, interval and side', async () => {
    const f = reply(body(LIST));
    const feed = createPoolDatafeed({ chain: 'bnb', pool: POOL, label: 'TART / USD', token: 'quote' }, { fetchImpl: f });
    await getBars(feed, '240', { from: 0, to: 1_700_002_000, countBack: 300, firstDataRequest: true });
    const url = new URL(String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]));
    expect(url.origin + url.pathname).toBe(`https://api.geckoterminal.com/api/v2/networks/bsc/pools/${POOL}/ohlcv/hour`);
    expect(url.searchParams.get('aggregate')).toBe('4');
    expect(url.searchParams.get('token')).toBe('quote');
    expect(url.searchParams.get('currency')).toBe('usd');
    expect(url.searchParams.get('limit')).toBe('300');
  });

  it('never asks for more than the service allows, and for at least a screenful', async () => {
    const f = reply(body(LIST));
    const feed = createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f });
    await getBars(feed, '15', { from: 0, to: 1_700_002_000, countBack: 5000, firstDataRequest: true });
    await getBars(feed, '5', { from: 0, to: 1_700_002_000, countBack: 3, firstDataRequest: true });
    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => new URL(String(c[0])).searchParams.get('limit'));
    expect(calls).toEqual(['1000', '200']);
  });

  it('includes the live candle on the first request and pages strictly backwards after that', async () => {
    const feed = createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: reply(body(LIST)) });
    const first = await getBars(feed, '15', { from: 0, to: 1_700_001_800, countBack: 300, firstDataRequest: true });
    expect('bars' in first && first.bars.map((b) => b.time / 1000)).toEqual([1_700_000_000, 1_700_000_900, 1_700_001_800]);
    // The chart already has everything from 1_700_000_900 onwards, so only older bars come back.
    const older = await getBars(feed, '15', { from: 0, to: 1_700_000_900, countBack: 300, firstDataRequest: false });
    expect('bars' in older && older.bars.map((b) => b.time / 1000)).toEqual([1_700_000_000]);
  });

  it('reports no data when a pool has no candles (new or unknown)', async () => {
    const feed = createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: reply({}, 404) });
    expect(await getBars(feed, '15', { from: 0, to: 1_700_002_000, firstDataRequest: true })).toEqual({ bars: [], noData: true });
  });

  it('says so plainly when the service is busy, down or unreachable, after trying a few times', async () => {
    const sleep = vi.fn(async () => undefined);
    const run = (f: typeof fetch) => getBars(createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f, sleep }), '15', { from: 0, to: 1, firstDataRequest: true });
    expect(await run(reply({}, 429))).toEqual({ error: 'The price service is busy. Try again in a minute.' });
    expect(await run(reply({}, 503))).toEqual({ error: 'The price service answered 503.' });
    const offline = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await run(offline)).toEqual({ error: 'The price service could not be reached.' });
    expect(offline).toHaveBeenCalledTimes(3);
  });

  it('recovers when the first try is refused for a moment (a spent allowance shows as a failed fetch)', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      waits.push(ms);
    };
    const f = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('{}', { status: 429 }))
      .mockResolvedValue(new Response(JSON.stringify(body(LIST))));
    const feed = createPoolDatafeed({ chain: 'bnb', pool: POOL, label: 'ARK / USD' }, { fetchImpl: f as unknown as typeof fetch, sleep });
    const r = await getBars(feed, '60', { from: 0, to: 1_700_001_800, countBack: 300, firstDataRequest: true });
    expect('bars' in r && r.bars).toHaveLength(3);
    expect(f).toHaveBeenCalledTimes(3);
    // It waits a little longer each time.
    expect(waits).toEqual([900, 1800]);
  });

  it('does not retry a missing pool, and live polls do not retry at all', async () => {
    const sleep = vi.fn(async () => undefined);
    const f404 = reply({}, 404);
    expect(await getBars(createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f404, sleep }), '15', { from: 0, to: 1, firstDataRequest: true })).toEqual({ bars: [], noData: true });
    expect(f404).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('refuses an interval the service cannot serve', async () => {
    const feed = createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: reply(body(LIST)) });
    expect(await getBars(feed, '3', { from: 0, to: 1, firstDataRequest: true })).toEqual({ error: 'The 3 interval is not available.' });
    expect(Object.keys(RESOLUTIONS)).toEqual(['1', '5', '15', '60', '240', '1D']);
  });

  it('resolves the one symbol it serves, 24 hours a day', async () => {
    const feed = createPoolDatafeed({ chain: 'ethereum', pool: '0xabc', label: 'PEPE / USD', priceHint: 0.00001, exchange: 'Uniswap' }, { fetchImpl: reply(body(LIST)) });
    const info = await new Promise<Parameters<Parameters<typeof feed.resolveSymbol>[1]>[0]>((resolve) => feed.resolveSymbol('x', resolve, () => undefined));
    expect(info).toMatchObject({ name: 'PEPE / USD', ticker: 'eth:0xabc', session: '24x7', timezone: 'Etc/UTC', pricescale: 1e8, exchange: 'Uniswap' });
  });

  it('polls for live ticks only while subscribed, and never goes back in time', async () => {
    vi.useFakeTimers();
    try {
      const f = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(body([[200, 1, 2, 1, 1.5, 1], [100, 1, 2, 1, 1.2, 1]]))))
        .mockResolvedValueOnce(new Response(JSON.stringify(body([[100, 1, 2, 1, 1.1, 1]]))))
        .mockResolvedValue(new Response(JSON.stringify(body([]))));
      const feed = createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f as unknown as typeof fetch, pollMs: 1000, now: () => 0 });
      const ticks: number[] = [];
      feed.subscribeBars({} as never, '1', (b) => ticks.push(b.time / 1000), 'uid');
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      // The second answer is older than what was already delivered, so it is skipped.
      expect(ticks).toEqual([100, 200]);
      feed.unsubscribeBars('uid');
      const callsBefore = f.mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.mock.calls.length).toBe(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});
