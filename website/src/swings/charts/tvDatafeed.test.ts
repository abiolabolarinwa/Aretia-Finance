import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyLivePrice, createPoolDatafeed, livePriceFrom, parseBars, priceScaleFor, resetCandleStore, RESOLUTIONS, type TvBar } from './tvDatafeed.js';
import { setGeckoGap } from './geckoGate.js';
import { resetUpstreamHealth } from './upstreamHealth.js';

// What a visit has learned about a failing route is shared by every datafeed, so each test starts without it. Direct reads
// are normally spaced about two seconds apart; the tests do not wait for that.
beforeEach(() => {
  resetUpstreamHealth();
  resetCandleStore();
  setGeckoGap(0);
});

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

  it('stops asking for older candles once a short answer shows the pool has no more history', async () => {
    const f = reply(body(LIST));
    let clock = 0;
    const feed = createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f, now: () => clock });
    const first = await getBars(feed, '15', { from: 0, to: 1_700_001_800, countBack: 300, firstDataRequest: true });
    expect('bars' in first && first.bars).toHaveLength(3);
    // 3 candles came back for 300 asked for, so the chart's follow-up request for older ones costs nothing.
    const older = await getBars(feed, '15', { from: 0, to: 1_700_000_000, countBack: 300, firstDataRequest: false });
    expect(older).toEqual({ bars: [], noData: true });
    expect(f).toHaveBeenCalledTimes(1);
    // A fresh first request (another symbol or interval load, once the short-lived cache has expired) checks again.
    clock += 60_000;
    await getBars(feed, '15', { from: 0, to: 1_700_001_800, countBack: 300, firstDataRequest: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('keeps paging while answers come back full', async () => {
    const full = Array.from({ length: 200 }, (_, i) => [1_700_000_000 + i * 900, 1, 2, 0.5, 1.5, 1]).reverse();
    const f = reply(body(full));
    const feed = createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f });
    await getBars(feed, '15', { from: 0, to: 1_700_000_000 + 200 * 900, countBack: 200, firstDataRequest: true });
    await getBars(feed, '15', { from: 0, to: 1_700_000_000, countBack: 200, firstDataRequest: false });
    expect(f).toHaveBeenCalledTimes(2);
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
    expect(waits).toEqual([300, 600]);
  });

  it('does not retry a missing pool, and live polls do not retry at all', async () => {
    const sleep = vi.fn(async () => undefined);
    const f404 = reply({}, 404);
    expect(await getBars(createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f404, sleep }), '15', { from: 0, to: 1, firstDataRequest: true })).toEqual({ bars: [], noData: true });
    expect(f404).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("asks Aretia's shared endpoint first, so the visitor's own allowance is not spent", async () => {
    const f = reply(body(LIST));
    const feed = createPoolDatafeed({ chain: 'polygon', pool: POOL, label: 'AIPF / USD', token: 'quote' }, { fetchImpl: f, viaServer: '/api/swings-ohlcv' });
    const r = await getBars(feed, '60', { from: 0, to: 1_700_001_800, countBack: 300, firstDataRequest: true });
    expect('bars' in r && r.bars).toHaveLength(3);
    const all = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(all).toHaveLength(1);
    const u = new URL(all[0]!, 'https://x.test');
    expect(u.pathname).toBe('/api/swings-ohlcv');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ chain: 'polygon', pool: POOL, tf: 'hour', agg: '1', limit: '300', token: 'quote' });
  });

  it('goes to GeckoTerminal directly when the shared endpoint is missing, refused or unreadable', async () => {
    for (const broken of [{ status: 404 }, { status: 502 }, { throws: true }, { garbage: true }]) {
      // Each case is a fresh visit.
      resetCandleStore();
      resetUpstreamHealth();
      const f = vi.fn(async (url: unknown) => {
        if (String(url).startsWith('/api/swings-ohlcv')) {
          if ('throws' in broken) throw new Error('offline');
          if ('garbage' in broken) return new Response('<html>', { status: 200 });
          return new Response('{}', { status: broken.status });
        }
        return new Response(JSON.stringify(body(LIST)));
      }) as unknown as typeof fetch;
      const feed = createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f, viaServer: '/api/swings-ohlcv', sleep: async () => undefined });
      const r = await getBars(feed, '15', { from: 0, to: 1_700_001_800, firstDataRequest: true });
      expect('bars' in r && r.bars).toHaveLength(3);
      const hosts = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]).slice(0, 12));
      expect(hosts[hosts.length - 1]).toBe('https://api.');
    }
  });

  it('stops asking a failing shared endpoint for a minute and goes straight to GeckoTerminal, then tries the endpoint again', async () => {
    let clock = 1_700_000_000_000;
    const f = vi.fn(async (url: unknown) => (String(url).startsWith('/api/swings-ohlcv') ? new Response('{}', { status: 502 }) : new Response(JSON.stringify(body(LIST))))) as unknown as typeof fetch;
    const feed = createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f, viaServer: '/api/swings-ohlcv', now: () => clock, sleep: async () => undefined, livePriceMs: 0 });
    const serverCalls = () => (f as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).startsWith('/api/swings-ohlcv') && !String(c[0]).includes('source=aretia')).length;
    // A fresh load each time: the interval changes, so nothing comes from the short-lived cache.
    await getBars(feed, '5', { from: 0, to: 1_700_001_800, countBack: 300, firstDataRequest: true });
    expect(serverCalls()).toBe(1);
    await getBars(feed, '15', { from: 0, to: 1_700_001_800, countBack: 300, firstDataRequest: true });
    await getBars(feed, '60', { from: 0, to: 1_700_001_800, countBack: 300, firstDataRequest: true });
    expect(serverCalls()).toBe(1);
    // The chart still gets its candles, from GeckoTerminal, without waiting on the endpoint each time.
    const direct = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => new URL(String(c[0]), 'https://x.test').hostname === 'api.geckoterminal.com').length;
    expect(direct).toBe(3);
    clock += 61_000;
    await getBars(feed, '240', { from: 0, to: 1_700_001_800, countBack: 300, firstDataRequest: true });
    expect(serverCalls()).toBe(2);
  });

  it('tells its owner when the first load of candles fails for good, so the chart can be started again, and not otherwise', async () => {
    const failures: string[] = [];
    const make = (f: typeof fetch) => createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f, sleep: async () => undefined, livePriceMs: 0, onLoadFailed: (m) => failures.push(m) });
    const down = vi.fn(async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    const first = { from: 0, to: 1_700_001_800, countBack: 300, firstDataRequest: true };
    await getBars(make(down), '15', first);
    expect(failures).toEqual(['The price service answered 503.']);
    // Paging back for older candles is not a failed load of the chart.
    await getBars(make(down), '15', { ...first, firstDataRequest: false });
    expect(failures).toHaveLength(1);
    // A pool with no candles, and a load that works, are not failures either.
    await getBars(make(reply({}, 404)), '15', first);
    await getBars(make(reply(body(LIST))), '15', first);
    expect(failures).toHaveLength(1);
  });

  it('names Aretia beside the symbol in the legend unless told otherwise', async () => {
    const resolve = (o: Partial<Parameters<typeof createPoolDatafeed>[0]> = {}) => {
      const feed = createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD', ...o }, { fetchImpl: reply(body(LIST)) });
      return new Promise<{ exchange: string; listed_exchange: string }>((r) => feed.resolveSymbol('x', r, () => undefined));
    };
    expect(await resolve()).toMatchObject({ exchange: 'aretiafinance.org', listed_exchange: 'aretiafinance.org' });
    expect(await resolve({ exchange: 'Uniswap' })).toMatchObject({ exchange: 'Uniswap' });
  });

  it('asks for prices in US dollars by default and in the other token when told to, direct and through the shared endpoint', async () => {
    const currencyOf = async (currency: 'usd' | 'token' | undefined, viaServer?: string) => {
      resetCandleStore();
      const f = reply(body(LIST));
      const feed = createPoolDatafeed({ chain: 'ethereum', pool: POOL, label: 'X', ...(currency ? { currency } : {}) }, { fetchImpl: f, ...(viaServer ? { viaServer } : {}) });
      await getBars(feed, '15', { from: 0, to: 1_700_001_800, countBack: 300, firstDataRequest: true });
      return new URL(String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]), 'https://x.test').searchParams.get('currency');
    };
    expect(await currencyOf(undefined)).toBe('usd');
    expect(await currencyOf('token')).toBe('token');
    expect(await currencyOf('token', '/api/swings-ohlcv')).toBe('token');
    expect(await currencyOf('usd', '/api/swings-ohlcv')).toBe('usd');
  });

  it('sizes the price scale from a real candle when prices are in the other token', async () => {
    const tiny = [[1_700_001_800, 0.00000012, 0.00000013, 0.00000011, 0.00000012, 5]];
    const feed = createPoolDatafeed({ chain: 'ethereum', pool: POOL, label: 'X / ETH', currency: 'token', priceHint: 3000 }, { fetchImpl: reply(body(tiny)), now: () => 1_700_001_900_000, sleep: async () => undefined });
    const info = await new Promise<{ pricescale: number }>((r) => feed.resolveSymbol('x', r, () => undefined));
    expect(info.pricescale).toBe(1e10);
    // If the candle cannot be read the chart still starts, on the default scale.
    const broken = createPoolDatafeed({ chain: 'ethereum', pool: POOL, label: 'X / ETH', currency: 'token' }, { fetchImpl: reply({}, 503), sleep: async () => undefined });
    expect((await new Promise<{ pricescale: number }>((r) => broken.resolveSymbol('x', r, () => undefined))).pricescale).toBe(1e6);
  });

  it('reads the first page once for both the symbol lookup and the first request, since a second request right behind the first is turned away', async () => {
    const f = reply(body(LIST));
    const feed = createPoolDatafeed({ chain: 'ethereum', pool: POOL, label: 'X / ETH', currency: 'token' }, { fetchImpl: f, now: () => 1_700_002_000_000 });
    const info = await new Promise<Parameters<Parameters<typeof feed.resolveSymbol>[1]>[0]>((r) => feed.resolveSymbol('x', r, () => undefined));
    // The chart asks for a different number of candles (and a time a few seconds off) than the lookup did.
    const r = await getBars(feed, '15', { from: 0, to: 1_700_002_003, countBack: 329, firstDataRequest: true });
    expect('bars' in r && r.bars).toHaveLength(3);
    expect(f).toHaveBeenCalledTimes(1);
    expect(info.pricescale).toBe(1e3);
  });

  it('serves only the newest candles asked for from a longer answer it already holds', async () => {
    const many = Array.from({ length: 50 }, (_, i) => [1_700_000_000 + i * 900, 1, 2, 0.5, 1.5, 1]).reverse();
    const f = reply(body(many));
    const feed = createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f, now: () => 1_700_045_000_000 });
    // Asks for 1000 first, so a later ask for fewer is answered from it, and one for more is not.
    await getBars(feed, '15', { from: 0, to: 1_700_045_000, countBack: 1000, firstDataRequest: true });
    const fewer = await getBars(feed, '15', { from: 0, to: 1_700_045_000, countBack: 200, firstDataRequest: true });
    expect('bars' in fewer && fewer.bars).toHaveLength(50);
    expect(f).toHaveBeenCalledTimes(1);
  });

  describe('speed: reading candles early, and not waiting on a slow endpoint', () => {
    const isServer = (u: unknown): boolean => String(u).startsWith('/api/swings-ohlcv');
    const make = (f: typeof fetch, extra: Partial<Parameters<typeof createPoolDatafeed>[1]> = {}) =>
      createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f, viaServer: '/api/swings-ohlcv', sleep: async () => undefined, livePriceMs: 0, indexerHeadStartMs: 0, ...extra });
    const first = { from: 0, to: 1_700_001_800, countBack: 330, firstDataRequest: true };
    const okBody = () => new Response(JSON.stringify(body(LIST)));
    const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    it('serves the chart from candles read when the token was opened, so the chart asks for nothing more', async () => {
      const f = vi.fn(async () => okBody()) as unknown as typeof fetch;
      // One datafeed reads early (as when a token is clicked); a second, made later, is the chart's own. They share a clock, as
      // they do in practice (the chart asks for candles up to "now").
      const at = { now: () => 1_700_001_805_000 };
      make(f, at).warm?.('15');
      await delay(5);
      const r = await getBars(make(f, at), '15', first);
      expect('bars' in r && r.bars).toHaveLength(3);
      expect(f).toHaveBeenCalledTimes(1);
    });

    it('joins a read that is still under way instead of making a second one', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const f = vi.fn(async () => {
        await gate;
        return okBody();
      }) as unknown as typeof fetch;
      const at = { hedgeMs: 10_000, now: () => 1_700_001_805_000 };
      make(f, at).warm?.('15');
      const chart = getBars(make(f, at), '15', first);
      release();
      const r = await chart;
      expect('bars' in r && r.bars).toHaveLength(3);
      expect(f).toHaveBeenCalledTimes(1);
    });

    it('does not reach for GeckoTerminal when the endpoint answers in time', async () => {
      const f = vi.fn(async () => okBody()) as unknown as typeof fetch;
      await getBars(make(f, { hedgeMs: 10_000 }), '15', first);
      expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.every((c) => isServer(c[0]))).toBe(true);
      expect(f).toHaveBeenCalledTimes(1);
    });

    it('reads GeckoTerminal directly as well when the endpoint is slow, and takes the answer that comes first', async () => {
      const f = vi.fn(async (u: unknown) => {
        if (isServer(u)) {
          await delay(300);
          return okBody();
        }
        return okBody();
      }) as unknown as typeof fetch;
      const started = Date.now();
      const r = await getBars(make(f, { hedgeMs: 20 }), '15', first);
      expect('bars' in r && r.bars).toHaveLength(3);
      // The direct read won; the slow endpoint did not hold the chart up for its 300ms.
      expect(Date.now() - started).toBeLessThan(250);
      expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c) => !isServer(c[0]))).toBe(true);
    });

    it('still gets the candles from a slow endpoint when the direct read is refused', async () => {
      const f = vi.fn(async (u: unknown) => {
        if (isServer(u)) {
          await delay(80);
          return okBody();
        }
        return new Response('{}', { status: 429 });
      }) as unknown as typeof fetch;
      const r = await getBars(make(f, { hedgeMs: 10 }), '15', first);
      expect('bars' in r && r.bars).toHaveLength(3);
    });

    it('reports the direct read\'s own message when both the endpoint and GeckoTerminal fail', async () => {
      const f = vi.fn(async (u: unknown) => {
        if (isServer(u)) {
          await delay(60);
          return new Response('{}', { status: 502 });
        }
        return new Response('{}', { status: 429 });
      }) as unknown as typeof fetch;
      const r = await getBars(make(f, { hedgeMs: 10 }), '15', first);
      expect(r).toEqual({ error: 'The price service is busy. Try again in a minute.' });
    });

    it('goes straight to GeckoTerminal, without hedging, when the endpoint fails quickly', async () => {
      const f = vi.fn(async (u: unknown) => (isServer(u) ? new Response('{}', { status: 502 }) : okBody())) as unknown as typeof fetch;
      const r = await getBars(make(f, { hedgeMs: 10_000 }), '15', first);
      expect('bars' in r && r.bars).toHaveLength(3);
      const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => !String(c[0]).includes('source=aretia')).map((c) => isServer(c[0]));
      expect(calls).toEqual([true, false]);
    });

    it('drops its read, and does not retry it, when the chart it was for has been closed', async () => {
      setGeckoGap(2_100);
      let closed = false;
      const f = vi.fn(async (u: unknown) => (isServer(u) ? new Response('{}', { status: 502 }) : okBody())) as unknown as typeof fetch;
      // A read for another token holds the line while this one waits; the chart is closed in the meantime.
      const at = { now: () => 1_700_001_805_000 };
      const ahead = createPoolDatafeed({ chain: 'solana', pool: 'OtherPool'.padEnd(44, 'x'), label: 'O' }, { fetchImpl: f, livePriceMs: 0, ...at });
      void ahead.warm?.('15');
      const feed = make(f, { ...at, cancelled: () => closed });
      const result = getBars(feed, '15', first);
      closed = true;
      const r = await result;
      expect(r).toEqual({ error: 'cancelled' });
      // Only the other token's read was made, and this one was not retried.
      const direct = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => new URL(String(c[0]), 'https://x.test').hostname === 'api.geckoterminal.com');
      expect(direct).toHaveLength(1);
    });

    it('asks a live poll for fresh candles even when the same ones were stored a moment ago', async () => {
      vi.useFakeTimers();
      try {
        const aligned = [[1_700_001_900, 3, 4, 2, 3.5, 30]];
        const f = vi.fn(async () => new Response(JSON.stringify(body(aligned)))) as unknown as typeof fetch;
        const clock = (1_700_001_900 + 100) * 1000;
        const feed = createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f, now: () => clock, pollMs: 1000, livePriceMs: 0, sleep: async () => undefined });
        await getBars(feed, '15', { from: 0, to: 1_700_001_900 + 100, countBack: 300, firstDataRequest: true });
        const before = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
        feed.subscribeBars({} as never, '15', () => undefined, 'poll');
        await vi.advanceTimersByTimeAsync(1000);
        expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
        feed.unsubscribeBars('poll');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('live price', () => {
    const dex = (priceUsd: string, priceNative: string) => ({ pairs: [{ priceUsd, priceNative }] });

    it('reads the charted token\'s price from the pair answer, in each of the four cases', () => {
      const body = dex('2', '0.5');
      expect(livePriceFrom(body, 'base', 'usd')).toBe(2);
      expect(livePriceFrom(body, 'base', 'token')).toBe(0.5);
      // The second token is worth 2 / 0.5 = 4 dollars, and 1 / 0.5 = 2 of the first token.
      expect(livePriceFrom(body, 'quote', 'usd')).toBe(4);
      expect(livePriceFrom(body, 'quote', 'token')).toBe(2);
    });

    it('gives nothing when the answer lacks what is needed or holds nonsense', () => {
      for (const bad of [null, {}, { pairs: [] }, { pairs: [{}] }, dex('x', '1'), dex('-1', '1'), dex('0', '0')]) {
        expect(livePriceFrom(bad, 'base', 'usd')).toBeNull();
      }
      expect(livePriceFrom({ pairs: [{ priceUsd: '2' }] }, 'quote', 'usd')).toBeNull();
      expect(livePriceFrom({ pairs: [{ priceUsd: '2' }] }, 'base', 'token')).toBeNull();
    });

    it('moves the candle on screen, or starts the next one', () => {
      const bar = { time: 1000, open: 1, high: 1.2, low: 0.9, close: 1.1, volume: 7 };
      expect(applyLivePrice(bar, 1.3, 1000)).toEqual({ time: 1000, open: 1, high: 1.3, low: 0.9, close: 1.3, volume: 7 });
      expect(applyLivePrice(bar, 0.8, 1000)).toMatchObject({ high: 1.2, low: 0.8, close: 0.8 });
      // A new period opens where the last one closed, with no volume yet.
      expect(applyLivePrice(bar, 1.2, 2000)).toEqual({ time: 2000, open: 1.1, high: 1.2, low: 1.1, close: 1.2, volume: 0 });
      expect(applyLivePrice(null, 5, 2000)).toEqual({ time: 2000, open: 5, high: 5, low: 5, close: 5, volume: 0 });
    });

    it('ignores a reading from the past and one that jumps threefold in a step', () => {
      const bar = { time: 5000, open: 1, high: 1, low: 1, close: 1, volume: 0 };
      expect(applyLivePrice(bar, 1.2, 4000)).toBeNull();
      expect(applyLivePrice(bar, 3.5, 5000)).toBeNull();
      expect(applyLivePrice(bar, 0.3, 5000)).toBeNull();
      expect(applyLivePrice(bar, 2.9, 5000)).not.toBeNull();
    });

    it('ticks the last candle from the live price between candle polls, and stops when unsubscribed', async () => {
      vi.useFakeTimers();
      try {
        // A 15 minute candle starts on a multiple of 900 seconds.
        const slotSec = 1_700_001_900;
        const aligned = [[slotSec, 3, 4, 2, 3.5, 30], [slotSec - 900, 2, 3, 1, 2.5, 20]];
        const f = vi.fn(async (url: unknown) => {
          const u = String(url);
          if (u.includes('/latest/dex/pairs/solana/')) return new Response(JSON.stringify(dex('3', '0.03')));
          return new Response(JSON.stringify(body(aligned)));
        });
        let clock = (slotSec + 100) * 1000;
        const feed = createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f as unknown as typeof fetch, now: () => clock, pollMs: 20_000, livePriceMs: 1000 });
        // The chart loads its candles first; the newest of them is where live readings start from.
        await getBars(feed, '15', { from: 0, to: slotSec + 100, countBack: 300, firstDataRequest: true });
        const ticks: TvBar[] = [];
        feed.subscribeBars({} as never, '15', (b) => ticks.push(b), 'u1');
        clock += 1000;
        await vi.advanceTimersByTimeAsync(1000);
        expect(ticks).toHaveLength(1);
        // The candle keeps its open, high, low and volume; its close follows the live price (3), down from 3.5.
        expect(ticks[0]).toEqual({ time: slotSec * 1000, open: 3, high: 4, low: 2, close: 3, volume: 30 });
        const calls = f.mock.calls.length;
        feed.unsubscribeBars('u1');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(f.mock.calls.length).toBe(calls);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not read the live price when it is switched off', async () => {
      vi.useFakeTimers();
      try {
        const f = vi.fn(async () => new Response(JSON.stringify(body(LIST)))) as unknown as typeof fetch;
        const feed = createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f, livePriceMs: 0, pollMs: 50_000 });
        feed.subscribeBars({} as never, '15', () => undefined, 'u2');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(f).not.toHaveBeenCalled();
        feed.unsubscribeBars('u2');
      } finally {
        vi.useRealTimers();
      }
    });
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
      const feed = createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f as unknown as typeof fetch, pollMs: 1000, now: () => 0, livePriceMs: 0 });
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

describe('a pool followed by Aretia\'s own Market Indexer', () => {
  it('reads only Aretia\'s endpoint (marked source=aretia) and never GeckoTerminal or DexScreener', async () => {
    const urls: string[] = [];
    const f = vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(body(LIST)), { status: 200 });
    }) as unknown as typeof fetch;
    const feed = createPoolDatafeed({ chain: 'bnb', pool: '0x' + 'c3'.repeat(20), label: 'MEME / USDT', source: 'aretia' }, { fetchImpl: f, viaServer: '/api/swings-ohlcv', livePriceMs: 0 });
    const r = await getBars(feed, '15', { from: 1_699_990_000, to: 1_700_002_000, countBack: 300, firstDataRequest: true });
    expect('bars' in r && r.bars.length).toBe(3);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u.startsWith('/api/swings-ohlcv?')).toBe(true);
      expect(u).toContain('source=aretia');
      expect(u).not.toMatch(/geckoterminal|dexscreener/);
    }
  });

  it('reports an error, rather than asking an outside service, when Aretia\'s endpoint fails', async () => {
    const urls: string[] = [];
    const f = vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response('{}', { status: 502 });
    }) as unknown as typeof fetch;
    const feed = createPoolDatafeed({ chain: 'bnb', pool: '0x' + 'c3'.repeat(20), label: 'MEME / USDT', source: 'aretia' }, { fetchImpl: f, viaServer: '/api/swings-ohlcv', livePriceMs: 0, sleep: async () => undefined });
    const r = await getBars(feed, '15', { from: 1_699_990_000, to: 1_700_002_000, countBack: 300, firstDataRequest: true });
    expect('error' in r).toBe(true);
    expect(urls.every((u) => u.startsWith('/api/swings-ohlcv'))).toBe(true);
  });
});

describe("Aretia's own index first", () => {
  const first = { from: 0, to: 1_700_001_800, countBack: 300, firstDataRequest: true };
  const isIndex = (u: unknown): boolean => String(u).includes('source=aretia');
  const feedWith = (f: typeof fetch) => createPoolDatafeed({ chain: 'solana', pool: POOL, label: 'X / USD' }, { fetchImpl: f, viaServer: '/api/swings-ohlcv', sleep: async () => undefined, livePriceMs: 0, indexerHeadStartMs: 200 });

  it('uses the stored trades of a pool the index follows, and never reads an outside service', async () => {
    const f = vi.fn(async (u: unknown) => (isIndex(u) ? new Response(JSON.stringify(body(LIST))) : new Response('{}', { status: 500 }))) as unknown as typeof fetch;
    const r = await getBars(feedWith(f), '15', first);
    expect('bars' in r && r.bars).toHaveLength(3);
    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calls.every((u) => u.includes('source=aretia'))).toBe(true);
  });

  it('reads the usual sources for a pool it does not follow, and does not ask again for five minutes', async () => {
    const f = vi.fn(async (u: unknown) => (isIndex(u) ? new Response('{"error":"unknown-pool"}', { status: 404 }) : new Response(JSON.stringify(body(LIST))))) as unknown as typeof fetch;
    const feed = feedWith(f);
    const a = await getBars(feed, '5', first);
    const b = await getBars(feed, '15', first);
    expect('bars' in a && a.bars).toHaveLength(3);
    expect('bars' in b && b.bars).toHaveLength(3);
    const asked = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => isIndex(c[0])).length;
    expect(asked).toBe(1);
  });

  it('falls back to the usual sources when the index has nothing for this window', async () => {
    const f = vi.fn(async (u: unknown) => (isIndex(u) ? new Response(JSON.stringify(body([]))) : new Response(JSON.stringify(body(LIST))))) as unknown as typeof fetch;
    const r = await getBars(feedWith(f), '15', first);
    expect('bars' in r && r.bars).toHaveLength(3);
  });
});
