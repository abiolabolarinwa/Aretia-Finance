import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchOverviewSample, overviewSampleNow, resetOverviewSample } from './overviewSample.js';

const pool = (i: number, dex = 'PumpSwap') => ({
  id: `solana:${i}`, chain: 'solana', address: 'P'.repeat(43) + String(i % 10), dex: 'pump', dexName: dex, kind: 'cpmm', feeTier: null, state: 'active', stateReason: '', createdAt: '2026-11-07T05:00:50.000Z', ageSeconds: 100,
  base: { address: 'B'.repeat(43) + String(i % 10), symbol: `T${i}`, name: `Token ${i}`, decimals: 6, nameFlags: [] }, quote: { address: 'So11111111111111111111111111111111111111112', symbol: 'WSOL', name: 'Wrapped SOL', decimals: 9, nameFlags: [] },
  price: { quote: '0.001', usd: 0.2 }, changePct: { m5: 1, h1: 2, h6: 3, h24: 4 }, volume: { quote: { h1: 1, h6: 1, m5: 1, h24: 1 }, usd: { h1: 100, h6: 200, m5: 10, h24: 1000 } }, txns: { buys: { h1: 1, h6: 1, m5: 1, h24: 10 }, sells: { h1: 1, h6: 1, m5: 1, h24: 10 } },
  liquidity: { quote: 10, usd: 5000 }, firstTradeAt: null, lastTradeAt: null, statsAsOf: null, evidence: 'fixture-tested', quoteIsDollar: false, links: { swap: '/x' },
});

describe('the overview sample', () => {
  it('leaves out pools the stats bar leaves out: no liquidity, or volume over 100 times it', async () => {
    const wash = { ...pool(3), liquidity: { quote: 1, usd: 50 } };
    const hot = { ...pool(4), liquidity: { quote: 1, usd: 5 }, volume: { quote: { h1: 1, h6: 1, m5: 1, h24: 1 }, usd: { h1: 1, h6: 1, m5: 1, h24: 100_000 } } };
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [pool(1), wash, hot], meta: { nextCursor: null } }))) as unknown as typeof fetch;
    const rows = await fetchOverviewSample('x', 1_000, f);
    expect(rows.map((r) => r.symbol)).toEqual(['T1']);
  });

  beforeEach(() => resetOverviewSample());

  it('reads the index\'s busiest pools by 24-hour value, with the exchange each trades on, and keeps them for two minutes', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ data: [pool(1), pool(2, 'Raydium')], meta: { nextCursor: null } }))) as unknown as typeof fetch;
    const rows = await fetchOverviewSample('', 1_000, f);
    expect(rows.map((r) => r.venue)).toEqual(['PumpSwap', 'Raydium']);
    expect(String((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0])).toContain('/api/v1/pools/top?limit=100');
    expect(overviewSampleNow('')).toHaveLength(2);
    await fetchOverviewSample('', 60_000, f);
    expect(f).toHaveBeenCalledTimes(1);
    await fetchOverviewSample('', 200_000, f);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('follows the cursor to a second page, asks for one network when given, and keeps what it had when a read fails', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [pool(1)], meta: { nextCursor: 'abc' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [pool(2)], meta: { nextCursor: null } })))
      .mockResolvedValue(new Response('{}', { status: 503 }));
    const rows = await fetchOverviewSample('solana', 1_000, f as unknown as typeof fetch);
    expect(rows).toHaveLength(2);
    const calls = (f as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(calls[0]).toContain('chain=solana');
    expect(calls[1]).toContain('cursor=abc');
    expect(await fetchOverviewSample('solana', 500_000, f as unknown as typeof fetch)).toHaveLength(2);
    expect(await fetchOverviewSample('base', 1_000, vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toEqual([]);
  });
});
