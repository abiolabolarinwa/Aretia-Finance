import { describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { GeckoTerminalCandles, parseOhlcv, priceChangePercent, TIMEFRAMES } from './candles.js';

const ACT = '7Ut5njM9ajGDjP83WvJmvrAcfi9JoVYrHSK5x5sSFrTG';
const POOL = '6n8Mvd7xmZs66E5VLGQGvtE31gbKMcTL4S97W4oV6ivX';
const row = (t: number, o = 1, h = 2, l = 0.5, c = 1.5, v = 10): number[] => [t, o, h, l, c, v];

describe('parseOhlcv', () => {
  it('returns candles oldest first, one per time, from the newest-first list the service sends', () => {
    const out = parseOhlcv([row(300), row(200), row(100)]);
    expect(out.map((c) => c.time)).toEqual([100, 200, 300]);
    expect(out[0]).toEqual({ time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
  });

  it('keeps one candle for a repeated time (the service does repeat them), deterministically', () => {
    const out = parseOhlcv([row(100, 1, 2, 1, 2, 5), row(100, 1, 3, 1, 3, 9), row(200)]);
    expect(out).toHaveLength(2);
    expect(out[0]!.close).toBe(3);
  });

  it('drops rows that are not numbers, are negative or zero priced, or are inconsistent, and never repairs them', () => {
    const bad: unknown[] = [
      'x', null, [1, 2], row(0), row(-5), [100, '1', 2, 1, 1, 1], [100, NaN, 2, 1, 1, 1], [100, 1, Infinity, 1, 1, 1],
      row(100, 0, 2, 0.5, 1), row(100, 1, 2, 0.5, 1, -1), row(100, 1, 0.4, 0.5, 0.45), row(100, 3, 2, 0.5, 1), row(100, 1, 2, 0.5, 0.1), row(100.5),
    ];
    expect(parseOhlcv(bad)).toEqual([]);
    expect(parseOhlcv(undefined)).toEqual([]);
    expect(parseOhlcv({})).toEqual([]);
  });

  it('property: whatever comes in, what comes out is strictly increasing in time and internally consistent', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: -5, max: 50 }), fc.double({ noNaN: false }), fc.double(), fc.double(), fc.double(), fc.double())), (rows) => {
        const out = parseOhlcv(rows);
        return out.every((c, i) => (i === 0 || c.time > out[i - 1]!.time) && c.high >= c.low && c.open <= c.high && c.open >= c.low && c.close <= c.high && c.close >= c.low && c.low > 0 && c.volume >= 0);
      }),
    );
  });
});

describe('priceChangePercent', () => {
  it('compares the first open with the last close', () => {
    expect(priceChangePercent(parseOhlcv([row(100, 2, 3, 1, 2), row(200, 2, 5, 2, 3)]))).toBeCloseTo(50);
    expect(priceChangePercent([])).toBeNull();
  });
});

describe('GeckoTerminalCandles', () => {
  const pools = (items: unknown[]) => ({ data: items });
  const pool = (address: string, liq: string, baseId: string, name = 'ACT / USDC') => ({ attributes: { address, name, reserve_in_usd: liq }, relationships: { base_token: { data: { id: baseId } } } });
  const serve = (routes: Record<string, unknown | number>) =>
    vi.fn(async (url: string) => {
      const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
      if (!hit) return new Response('{}', { status: 404 });
      return typeof hit[1] === 'number' ? new Response('{}', { status: hit[1] }) : new Response(JSON.stringify(hit[1]), { status: 200 });
    }) as unknown as typeof fetch;

  it('finds the deepest pool, asks for the token\'s own side, and returns clean candles', async () => {
    const f = serve({
      '/tokens/': pools([pool('shallowPoolAddress1234567890', '100', `solana_${ACT}`), pool(POOL, '24752.2', `solana_${ACT}`)]),
      '/ohlcv/': { data: { attributes: { ohlcv_list: [row(300), row(200), row(200, 1, 1.2, 1, 1.1)] } } },
    });
    const s = await new GeckoTerminalCandles(f).candles('solana', ACT, '1h');
    expect(s.pool).toBe(POOL);
    expect(s.liquidityUsd).toBeCloseTo(24752.2);
    expect(s.candles.map((c) => c.time)).toEqual([200, 300]);
    const url = String((f as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0]);
    expect(url).toContain(`/pools/${POOL}/ohlcv/hour?aggregate=1&limit=${TIMEFRAMES['1h'].limit}&currency=usd&token=base`);
  });

  it('prefers a pool paired with a major token over a deeper-looking pool paired with something else', async () => {
    const usdc = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const inflated = { attributes: { address: 'InflatedPoolAddress1234567890', name: 'ACT / FAKE', reserve_in_usd: '180000000' }, relationships: { base_token: { data: { id: `solana_${ACT}` } }, quote_token: { data: { id: 'solana_SomeMadeUpTokenMint1111111111111111111' } } } };
    const real = { attributes: { address: POOL, name: 'ACT / USDC', reserve_in_usd: '24000' }, relationships: { base_token: { data: { id: `solana_${ACT}` } }, quote_token: { data: { id: `solana_${usdc}` } } } };
    const f = serve({ '/tokens/': pools([inflated, real]), '/ohlcv/': { data: { attributes: { ohlcv_list: [row(100), row(200)] } } } });
    expect((await new GeckoTerminalCandles(f).candles('solana', ACT, '1h')).pool).toBe(POOL);
  });

  it('works out the side correctly when the token is the pool\'s quote token paired with a major', async () => {
    const wsol = 'So11111111111111111111111111111111111111112';
    const f = serve({ '/tokens/': pools([{ attributes: { address: POOL, name: 'X / SOL', reserve_in_usd: '5' }, relationships: { base_token: { data: { id: 'solana_SomeBaseTokenMint11111111111111111111111' } }, quote_token: { data: { id: `solana_${wsol}` } } } }]), '/ohlcv/': { data: { attributes: { ohlcv_list: [row(100), row(200)] } } } });
    await new GeckoTerminalCandles(f).candles('solana', wsol, '1h');
    expect(String((f as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0])).toContain('token=quote');
  });

  it('asks for the quote side when the token is the pool\'s quote token', async () => {
    const f = serve({ '/tokens/': pools([pool(POOL, '500', 'solana_SomeOtherBaseTokenMint1111111111111111111')]), '/ohlcv/': { data: { attributes: { ohlcv_list: [row(100), row(200)] } } } });
    await new GeckoTerminalCandles(f).candles('solana', ACT, '1d');
    expect(String((f as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0])).toContain('token=quote');
  });

  it('says plainly when there is no pool, too little history, a busy service, or an unreachable one', async () => {
    const src = (f: typeof fetch) => new GeckoTerminalCandles(f);
    await expect(src(serve({ '/tokens/': pools([]) })).candles('solana', ACT, '1h')).rejects.toMatchObject({ code: 'no-route' });
    await expect(src(serve({ '/tokens/': pools([pool(POOL, '5', `solana_${ACT}`)]), '/ohlcv/': { data: { attributes: { ohlcv_list: [row(100)] } } } })).candles('solana', ACT, '1h')).rejects.toMatchObject({ code: 'no-route' });
    await expect(src(serve({ '/tokens/': 429 })).candles('solana', ACT, '1h')).rejects.toThrow(/busy/);
    await expect(src(serve({ '/tokens/': 404 })).candles('solana', ACT, '1h')).rejects.toMatchObject({ code: 'no-route' });
    await expect(src((async () => { throw new Error('offline'); }) as unknown as typeof fetch).candles('solana', ACT, '1h')).rejects.toThrow(/could not be reached/);
  });

  it('refuses a bad address or timeframe before asking the network anything', async () => {
    const f = serve({});
    await expect(new GeckoTerminalCandles(f).candles('ethereum', 'nope', '1h')).rejects.toMatchObject({ code: 'invalid' });
    await expect(new GeckoTerminalCandles(f).candles('solana', ACT, '5y' as never)).rejects.toMatchObject({ code: 'invalid' });
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('reuses a recent answer for a minute, then asks again', async () => {
    const f = serve({ '/tokens/': pools([pool(POOL, '5', `solana_${ACT}`)]), '/ohlcv/': { data: { attributes: { ohlcv_list: [row(100), row(200)] } } } });
    let t = 1_000;
    const src = new GeckoTerminalCandles(f, undefined, () => t);
    await src.candles('solana', ACT, '1h');
    const first = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    await src.candles('solana', ACT, '1h');
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(first);
    await src.candles('solana', ACT, '1d'); // a different timeframe is a different request
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(first);
    t += 61_000;
    const before = (f as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    await src.candles('solana', ACT, '1h');
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(before);
  });

  it('ignores pool entries with unusable addresses', async () => {
    const f = serve({ '/tokens/': pools([pool('bad address!', '999999', `solana_${ACT}`), pool(POOL, '1', `solana_${ACT}`)]), '/ohlcv/': { data: { attributes: { ohlcv_list: [row(100), row(200)] } } } });
    expect((await new GeckoTerminalCandles(f).candles('solana', ACT, '4h')).pool).toBe(POOL);
  });
});
